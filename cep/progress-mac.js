// Fig2AE: the import progress window over After Effects (macOS) — the twin of progress.ps1 (Windows).
// server.js starts it with: osascript -l JavaScript progress-mac.js <settings dir> <comp name, base64>
// While the importer runs, After Effects is busy on its main thread and none of its own windows takes a click,
// so this is a process of its own (JavaScript for Automation, built into macOS — nothing to install).
// It floats over every app (After Effects in full screen too), reads <dir>/progress.json (written by the importer,
// Fig2AE.jsx) and writes <dir>/cancel.txt: "stop" keeps what is built, "cancel" removes it.
// Closes itself when the import is over; when fonts were missing it stays with their list until closed.
ObjC.import('Cocoa');
// Cocoa enum values as numbers: JXA does not bridge every enum constant
var POLICY_ACCESSORY = 1, MASK_TITLED = 1, MASK_UTILITY = 16, MASK_NONACTIVATING = 128, BACKING_BUFFERED = 2,
    LEVEL_STATUS = 25, LEVEL_FLOATING = 3, SPACES_ALL = 1, SPACES_FULLSCREEN_AUX = 256,
    BREAK_WORD = 0, BREAK_TRUNC_TAIL = 4, BEZEL_ROUNDED = 1, NO_BORDER = 0, UTF8 = 4;

function run(argv) {
    var dir = String(argv[0] || ''), name = '';
    try {
        if (argv[1]) {
            var data = $.NSData.alloc.initWithBase64EncodedStringOptions(String(argv[1]), 0);
            name = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, UTF8)) || '';
        }
    } catch (e) {}
    var progFile = dir + '/progress.json', cancelFile = dir + '/cancel.txt';
    var started = Date.now(), seen = false, fontsShown = false, ticks = 0;

    var app = $.NSApplication.sharedApplication;
    app.setActivationPolicy(POLICY_ACCESSORY);       // no Dock icon, no menu bar of its own

    var W = 380, H = 128;
    var scr = $.NSScreen.mainScreen.visibleFrame;
    var x = scr.origin.x + (scr.size.width - W) / 2, y = scr.origin.y + scr.size.height * 0.38 - H / 2;
    var style = MASK_TITLED | MASK_UTILITY | MASK_NONACTIVATING;
    var win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(x, y, W, H), style, BACKING_BUFFERED, false);
    win.title = 'Fig2AE';
    win.level = LEVEL_STATUS;                    // over After Effects and every other app
    win.collectionBehavior = SPACES_ALL | SPACES_FULLSCREEN_AUX;
    win.hidesOnDeactivate = false;
    win.releasedWhenClosed = false;
    try { win.appearance = $.NSAppearance.appearanceNamed('NSAppearanceNameDarkAqua'); } catch (e) {}
    var view = win.contentView;

    function label(text, x0, y0, w0, h0, size, bold, grey) {
        var t = $.NSTextField.alloc.initWithFrame($.NSMakeRect(x0, y0, w0, h0));
        t.stringValue = text; t.editable = false; t.selectable = false; t.bezeled = false; t.drawsBackground = false;
        t.font = bold ? $.NSFont.boldSystemFontOfSize(size) : $.NSFont.systemFontOfSize(size);
        if (grey) t.textColor = $.NSColor.secondaryLabelColor;
        t.lineBreakMode = BREAK_TRUNC_TAIL;
        view.addSubview(t);
        return t;
    }
    var title = label('Importing from Figma' + (name ? ' · ' + name : ''), 14, H - 32, W - 28, 18, 13, true, false);
    var bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(14, H - 54, W - 28, 12));
    bar.indeterminate = false; bar.minValue = 0; bar.maxValue = 1; bar.doubleValue = 0;
    view.addSubview(bar);
    var info = label('Waiting for After Effects…', 14, H - 80, W - 28, 18, 12, false, true);

    function readJSON(path) {
        try {
            var s = $.NSString.stringWithContentsOfFileEncodingError(path, UTF8, null);
            return s && !s.isNil() ? JSON.parse(ObjC.unwrap(s)) : null;
        } catch (e) { return null; }
    }
    function writeText(path, text) {
        try { $(text).writeToFileAtomicallyEncodingError(path, true, UTF8, null); } catch (e) {}
    }
    function quit() { win.orderOut(null); app.terminate(null); }
    function aeRunning() {
        try {
            var list = $.NSWorkspace.sharedWorkspace.runningApplications;
            for (var i = 0; i < list.count; i++) {
                var id = ObjC.unwrap(list.objectAtIndex(i).bundleIdentifier) || '';
                if (id.indexOf('com.adobe.AfterEffects') === 0) return true;
            }
            return false;
        } catch (e) { return true; }                       // unsure: keep the window
    }

    var stopBtn, cancelBtn, copyBtn, closeBtn, names = [];
    function sendCancel(how, msg) {
        writeText(cancelFile, how);
        stopBtn.enabled = false; cancelBtn.enabled = false;
        info.stringValue = msg; info.textColor = $.NSColor.labelColor;
    }

    // after the import: the fonts AE did not find, even by a similar name ("Family Style<TAB>stand-in")
    function showFonts(missing, renamed) {
        fontsShown = true;
        stopBtn.hidden = true; cancelBtn.hidden = true; bar.hidden = true;
        win.level = LEVEL_FLOATING;                // stays, but no longer over everything
        var n = missing.length, r = renamed.length, lines = [];
        if (n) {
            title.stringValue = n === 1 ? '1 font is not installed' : n + ' fonts are not installed';
            title.textColor = $.NSColor.systemOrangeColor;
            info.stringValue = 'After Effects used a stand-in. Install them, then press "Re-check missing fonts" in the Fig2AE panel.';
        } else {
            title.stringValue = r === 1 ? '1 font was found under a similar name' : r + ' fonts were found under a similar name';
            title.textColor = $.NSColor.systemGreenColor;
            info.stringValue = 'Figma calls them a little differently than this computer does. Check that the right font was picked.';
        }
        if (n && r) lines.push('NOT INSTALLED — stand-in used');
        missing.forEach(function (it) { var p = String(it).split('\t'); names.push(p[0]); lines.push(p[0] + (p[1] ? '   → ' + p[1] : '')); });
        if (n && r) lines.push('', 'FOUND UNDER A SIMILAR NAME');
        renamed.forEach(function (it) { var p = String(it).split('\t'); names.push(p[0]); lines.push(p[0] + (p[1] ? '   = ' + p[1] : '')); });
        var listH = Math.min(12, lines.length) * 17 + 8, newH = 72 + listH + 52;
        win.setContentSize($.NSMakeSize(W, newH));
        title.frame = $.NSMakeRect(14, newH - 32, W - 28, 18);
        info.frame = $.NSMakeRect(14, newH - 66, W - 28, 32);
        info.lineBreakMode = BREAK_WORD;
        var scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(14, 50, W - 28, listH));
        scroll.hasVerticalScroller = true; scroll.borderType = NO_BORDER;
        var tv = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, W - 28, listH));
        tv.editable = false; tv.string = lines.join('\n'); tv.font = $.NSFont.systemFontOfSize(12);
        scroll.documentView = tv;
        view.addSubview(scroll);
        copyBtn.hidden = false; closeBtn.hidden = false;
        win.title = 'Fig2AE · fonts';
    }

    ObjC.registerSubclass({
        name: 'F2AProgressHandler',
        methods: {
            'stop:': { types: ['void', ['id']], implementation: function () { sendCancel('stop', 'Stopping after the current layer…'); } },
            'cancel:': { types: ['void', ['id']], implementation: function () { sendCancel('cancel', 'Cancelling — removing what was built…'); } },
            'copyNames:': { types: ['void', ['id']], implementation: function () {
                var pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.setStringForType(names.join('\n'), $.NSPasteboardTypeString);
                copyBtn.title = 'Copied';
            } },
            'closeWin:': { types: ['void', ['id']], implementation: function () { quit(); } },
            'tick:': { types: ['void', ['id']], implementation: function () {
                ticks++;
                var p = readJSON(progFile);
                if (p && p.t >= started - 3000) {
                    if (p.state === 'running') {
                        seen = true;
                        var tot = Math.max(1, +p.total || 1);
                        bar.doubleValue = Math.min(1, (+p.n || 0) / tot);
                        if (stopBtn.enabled) info.stringValue = p.n + ' / ' + p.total + ' layers' + (p.layer ? ' · ' + p.layer : '');
                    } else if (p.state === 'done' && ((p.missing && p.missing.length) || (p.renamed && p.renamed.length))) {
                        if (!fontsShown) showFonts((p.missing || []).filter(Boolean), (p.renamed || []).filter(Boolean));
                    } else if (!fontsShown && (seen || Date.now() - started > 5000)) quit();
                }
                if (!fontsShown && ticks % 10 === 0 && !aeRunning()) quit();           // After Effects closed or crashed
                if (!fontsShown && Date.now() - started > 3 * 3600 * 1000) quit();      // never left behind
            } }
        }
    });
    var handler = $.F2AProgressHandler.alloc.init;

    function button(text, x0, action, hidden) {
        var b = $.NSButton.alloc.initWithFrame($.NSMakeRect(x0, 12, 170, 28));
        b.title = text; b.bezelStyle = BEZEL_ROUNDED;
        b.target = handler; b.action = action;
        b.hidden = !!hidden;
        view.addSubview(b);
        return b;
    }
    stopBtn = button('Stop — keep what is built', 14, 'stop:', false);
    cancelBtn = button('Cancel — remove all', 196, 'cancel:', false);
    copyBtn = button('Copy names', 14, 'copyNames:', true);
    closeBtn = button('Close', 196, 'closeWin:', true);

    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.2, handler, 'tick:', null, true);
    win.orderFrontRegardless;                             // shown over After Effects without taking the focus from it
    app.run;
}
