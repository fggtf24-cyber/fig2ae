/**
 * Fig2AE panel (Window > Fig2AE.jsx) — manual import only.
 *
 * Automatic import is done by the Fig2AE Server CEP extension (cep/), which
 * starts with After Effects and takes exports straight from the Figma plugin.
 * This panel is the fallback for files saved to disk (AE was closed, the server
 * is not installed): import the newest fig2ae_*.jsx from a folder, or any file.
 *
 * No polling here on purpose: an app.scheduleTask timer pops "Cannot run a
 * script while a modal dialog is waiting for response" whenever an AE dialog is open.
 */
(function (thisObj) {
    var KEY = 'Fig2AE';

    function setting(k, def) {
        try { if (app.settings.haveSetting(KEY, k)) return app.settings.getSetting(KEY, k); } catch (e) {}
        return def;
    }
    function save(k, v) { try { app.settings.saveSetting(KEY, k, v); } catch (e) {} }
    // "~" in ExtendScript follows Documents (often redirected to OneDrive), not the user profile
    function defaultDownloads() {
        var up = $.getenv('USERPROFILE');
        if (up && new Folder(up + '/Downloads').exists) return new Folder(up + '/Downloads');
        return new Folder('~/Downloads');
    }
    function folder() { return new Folder(setting('folder', defaultDownloads().fsName)); }

    function exportsIn(d) {
        var fs = d.exists ? d.getFiles('fig2ae_*.jsx') : [], out = [];
        for (var i = 0; i < fs.length; i++) if (fs[i] instanceof File) out.push(fs[i]);
        out.sort(function (a, b) { return a.modified.getTime() - b.modified.getTime(); });
        return out;
    }

    /** files from the current plugin end with this marker; an old export does not (it hangs AE) */
    function complete(f) {
        try {
            f.encoding = 'BINARY';
            if (!f.open('r')) return false;
            f.seek(Math.max(0, f.length - 64));
            var tail = f.read();
            f.close();
            return tail.indexOf('F2A-PAYLOAD-END*/') >= 0;
        } catch (e) { return false; }
    }

    var w = (thisObj instanceof Panel) ? thisObj : new Window('palette', 'Fig2AE', undefined, { resizeable: true });
    w.orientation = 'column'; w.alignChildren = ['fill', 'top']; w.spacing = 6; w.margins = 8;
    w.add('statictext', undefined, 'Auto-import is done by Fig2AE Server. Here: files from disk.', { multiline: true });
    var row = w.add('group');
    row.orientation = 'row'; row.alignChildren = ['left', 'center'];
    row.add('statictext', undefined, 'Folder:');
    var folderText = row.add('statictext', undefined, folder().fsName, { truncate: 'middle' });
    folderText.preferredSize.width = 150;
    var pick = row.add('button', undefined, '…');
    pick.preferredSize = [28, 22];
    var btnLast = w.add('button', undefined, 'Import latest export');
    var btnFile = w.add('button', undefined, 'Open file…');
    var status = w.add('edittext', undefined, '', { multiline: true, readonly: true, scrolling: true });
    status.preferredSize = [260, 140];

    function importFile(f) {
        if (!complete(f)) { status.text = '"' + File.decode(f.name) + '" is an old export format that hangs AE. Export it again.'; return; }
        $.global.F2A_QUIET = true;
        $.global.F2A_LAST = null;
        try { $.evalFile(f); }
        catch (e) { status.text = 'Error in ' + File.decode(f.name) + ': ' + e; }
        $.global.F2A_QUIET = false;
        var r = $.global.F2A_LAST;
        if (!r) return;
        var all = r.log.concat(r.figmaWarnings || []);
        status.text = (r.comp ? '✓ "' + r.comp.name + '" imported in ' + r.secs.toFixed(1) + ' s' : 'Import not finished') +
                      (all.length ? '\n\nNot transferred 1:1 (' + all.length + '):\n' + all.join('\n') : '');
    }

    btnLast.onClick = function () {
        var fs = exportsIn(folder());
        if (fs.length) importFile(fs[fs.length - 1]);
        else status.text = 'No fig2ae_*.jsx files in the folder';
    };
    btnFile.onClick = function () {
        var f = File.openDialog('Fig2AE export file', '*.jsx');
        if (f) importFile(f);
    };
    pick.onClick = function () {
        var d = folder().selectDlg('Folder where Figma saves exports');
        if (d) { folderText.text = d.fsName; save('folder', d.fsName); }
    };

    w.onResizing = w.onResize = function () { this.layout.resize(); };
    if (w instanceof Window) { w.center(); w.show(); } else w.layout.layout(true);
})(this);
