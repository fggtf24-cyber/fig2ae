/**
 * Fig2AE — After Effects side.
 * Normally you never run this file directly: the Figma plugin saves a
 * fig2ae_<name>.jsx that already contains this importer plus the data
 * (built by `node build.js`). Run directly, it asks for a .json export.
 * geom.jsx must sit next to this file.
 *
 * Tested on AE 26.2. Uses newer APIs when present (fonts API 24.0, per-character
 * text 24.3, box text insets 24.6, setTrackMatte 23.0) and degrades with a
 * warning on older versions.
 */
#include "geom.jsx"

(function fig2ae() {

    /* Measured in AE 26.2 by test/ae/calibrate.jsx (edge profile of a rendered step):
       Gaussian Blur:  sigma = Blurriness / 3.55
       Drop Shadow:    sigma = 0.1917 * Softness + 0.5   (fits 5..100 within 0.05 px)
       Fast Box Blur:  see boxRadius() */
    var AE_BLUR_PER_SIGMA = 3.55;
    // Fast Box Blur, 3 iterations:  sigma = 1.0318 * Radius + 0.494   (fits 5..40)
    function boxRadius(sigma) { return Math.max(0, (sigma - 0.494) / 1.0318); }
    function shadowSoftness(sigma) { return Math.max(0, (sigma - 0.5) / 0.1917); }

    var G = F2A_GEOM;
    var LOG = [];
    var fontCache = {}, imgCache = {}, imgSeq = 0, gradSeq = 0, assets = null, openedComps = {};
    var missingFonts = {};  // "Family Style" -> { sub, layers }
    var lastInk = null;   // set by placeByInk for the text layer being built (AE host objects take no expandos)
    function note(t) { if (LOG.join('\n').indexOf(t) < 0) LOG.push(t); }

    /* ---------------------------------------------------------- entry */

    function main() {
        if (!canWriteFiles()) {
            alert('Fig2AE needs permission to write files (images and gradients).\n\n' +
                  ($.os.indexOf('Windows') >= 0 ? 'Edit > Preferences' : 'After Effects > Settings') +
                  ' > Scripting & Expressions >\n"Allow Scripts to Write Files and Access Network".');
            return;
        }
        var doc, assetsDir;
        if (typeof F2A_DATA !== 'undefined' && F2A_DATA) {
            // the .jsx saved by the Figma plugin carries its own data
            var me = new File($.fileName);
            doc = F2A_DATA;
            F2A_DATA = null;     // globals outlive the script in AE: never let a later run pick this up
            assetsDir = new Folder(me.parent.fsName + '/' + File.decode(me.name).replace(/\.jsx(bin)?$/i, '') + '_assets');
            if (!doc || doc.app !== 'fig2ae') { alert('This is not a Fig2AE file'); return; }
        } else {
            // standalone importer: pick a .json export
            var f = File.openDialog('Choose a fig2ae_*.json file', '*.json');
            if (!f) return;
            doc = readDoc(f);
            if (!doc) return;
            assetsDir = new Folder(f.parent.fsName + '/fig2ae_assets');
        }
        var res = importDoc(doc, assetsDir);
        res.figmaWarnings = doc.warnings || [];
        $.global.F2A_LAST = res;
        if (!$.global.F2A_QUIET) report(doc, res);
    }

    function readDoc(f) {
        f.encoding = 'UTF-8';
        if (!f.open('r')) { alert('Cannot open the file'); return null; }
        var txt = f.read();
        f.close();
        var doc;
        // ponytail: ExtendScript has no JSON parser; eval on our own export file
        // is fine. Ceiling: a hand-edited/corrupt file can throw or run code.
        // Upgrade path: bundle json2.js if this ever reads third-party files.
        try { doc = eval('(' + txt + ')'); } catch (e) { alert('The file is damaged: ' + e); return null; }
        if (!doc || doc.app !== 'fig2ae') { alert('This is not a Fig2AE file'); return null; }
        return doc;
    }

    function canWriteFiles() {
        try { return app.preferences.getPrefAsLong('Main Pref Section', 'Pref_SCRIPTING_FILE_NETWORK_SECURITY') === 1; }
        catch (e) { return true; }    // unknown pref layout: let the first write tell
    }

    /** the whole import; also the entry point for tests */
    /**
     * <user data>/Fig2AE/progress.json, every 15 layers: the Figma plugin shows "N / total",
     * and if After Effects dies mid-import the server reports where it stopped.
     */
    var PROG = null;
    function countDoc(ls) {
        var n = 0;
        for (var i = 0; i < ls.length; i++) {
            var l = ls[i]; if (!l) continue;
            n++;
            if (l.matte) n += countDoc([l.type === 'bgblur' ? l.matte : l.matte.layer]);
            if (l.comp) n += countDoc(l.comp.layers);
        }
        return n;
    }
    function jstr(v) {
        return '"' + String(v).replace(/[\\"]/g, '\\$&').replace(/[\u0000-\u001f\u2028\u2029]/g, function (c) {
            return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function dataDir() {
        var d = new Folder(Folder.userData.fsName + '/Fig2AE');
        if (!d.exists) d.create();
        return d;
    }
    function writeProgress(state, name) {
        if (!PROG) return;
        try {
            var f = new File(dataDir().fsName + '/progress.json');
            f.encoding = 'UTF-8';
            if (!f.open('w')) return;
            f.write('{"state":"' + state + '","n":' + PROG.n + ',"total":' + PROG.total + ',"t":' + new Date().getTime() +
                    ',"comp":' + jstr(PROG.comp) + ',"layer":' + jstr(name || '') + '}');
            f.close();
            PROG.last = new Date().getTime();
        } catch (e) {}
    }
    /**
     * <user data>/Fig2AE/cancel.txt: the progress window (cep/progress.ps1) writes "stop" (keep what is
     * built) or "cancel" (take it all out again). AE runs this script on its main thread, so no AE window
     * can take a click meanwhile; the progress window is a process of its own.
     */
    var CANCEL = { f2aCancel: true };
    function cancelFile() { return new File(dataDir().fsName + '/cancel.txt'); }
    function progress(L) {
        if (!PROG) return;
        PROG.n++;
        if (PROG.n === 1 || new Date().getTime() - PROG.last > 200) writeProgress('running', L.name);
        if (!PROG.hold && PROG.cf.exists) {
            var f = PROG.cf, how = 'stop';
            try { f.open('r'); how = f.read(); f.close(); f.remove(); } catch (e) {}
            PROG.cancel = /cancel/.test(how) ? 'cancel' : 'stop';
            throw CANCEL;
        }
    }

    /* Project panel: Fig2AE / <scene> [ (2), (3)… for repeats ] / main comp, Precomps/, Images/ */
    var FOLDERS = null;
    function sceneFolders(name) {
        var root = app.project.rootFolder, top = null, i;
        for (i = 1; i <= root.numItems; i++) {
            var it = root.item(i);
            if (it instanceof FolderItem && it.name === 'Fig2AE') { top = it; break; }
        }
        if (!top) top = app.project.items.addFolder('Fig2AE');
        var base = String(name || 'Figma').replace(/^\s+|\s+$/g, '') || 'Figma', taken = {};
        for (i = 1; i <= top.numItems; i++) taken[top.item(i).name] = true;
        var k = 1, nm = base;
        while (taken[nm]) nm = base + ' (' + (++k) + ')';
        var scene = app.project.items.addFolder(nm);
        scene.parentFolder = top;
        return { top: top, scene: scene, suffix: k > 1 ? ' (' + k + ')' : '', pre: null, img: null };
    }
    function subFolder(key, name) {
        if (!FOLDERS[key]) { FOLDERS[key] = app.project.items.addFolder(name); FOLDERS[key].parentFolder = FOLDERS.scene; }
        return FOLDERS[key];
    }

    function importDoc(doc, assetsFolder) {
        PROG = { n: 0, total: countDoc(doc.comp.layers), comp: doc.comp.name || '', last: 0, cf: cancelFile(), cancel: null, hold: 0 };
        try { if (PROG.cf.exists) PROG.cf.remove(); } catch (e) {}      // a click left over from an import that already ended
        writeProgress('running', '');
        LOG = [];
        missingFonts = {};
        assets = assetsFolder;
        if (!assets.exists) assets.create();
        if (!app.project) app.newProject();
        var toWorking = colorChecks();
        if (toWorking) recolor(doc.comp, toWorking);

        var t0 = new Date().getTime(), comp = null, opts = readOpts(doc), mode = 'new', cancelled = null;
        var target = null, n0 = 0, at = 0;
        app.beginUndoGroup('Fig2AE: import from Figma');
        try {
            target = opts.target === 'current' ? activeComp() : null;
            if (opts.target === 'current' && !target) note('"Current" is selected, but no composition is active — a new comp was created');
            FOLDERS = sceneFolders(doc.comp.name);
            // While building, the viewer shows an empty 4×4 comp. Otherwise AE redraws the comp (and its timeline)
            // shown in the viewer after every added layer, which makes big frames take minutes.
            // Opened after reading the active comp: opening it makes it the active item.
            openScratch();
            if (target) {
                // like AEUX "Current": the layers go into the active comp, the frame centred in it
                mode = 'current';
                var dx = (target.width - compSide(doc.comp.w, doc.comp.name)) / 2, dy = (target.height - compSide(doc.comp.h, doc.comp.name)) / 2;
                if (dx || dy) for (var i = 0; i < doc.comp.layers.length; i++) shiftLayer(doc.comp.layers[i], dx, dy);
                // precomps get the frame rate and length of the comp they go into
                doc.fps = target.frameRate; doc.duration = target.duration;
                n0 = target.numLayers; at = target.time;
                comp = target;
                fillComp(target, doc.comp, doc);
                startAt(target, target.numLayers - n0, at);
                // a new Figma reference replaces the one from the previous import (the new one is among the top layers)
                var hasRef = false;
                for (var r = 0; r < doc.comp.layers.length; r++) if (doc.comp.layers[r].guide) hasRef = true;
                var firstOld = target.numLayers - n0;
                if (hasRef) for (var q = target.numLayers; q > firstOld; q--) {
                    var old = target.layer(q);
                    if (old.comment === REF_TAG) { old.locked = false; old.remove(); }
                }
            } else {
                doc.comp.name = (doc.comp.name || 'comp') + FOLDERS.suffix;
                comp = buildComp(doc.comp, doc, true);
            }
        } catch (e) {
            if (e === CANCEL) cancelled = PROG.cancel;
            else LOG.unshift('ERROR (line ' + e.line + '): ' + e.toString());
        }
        if (cancelled === 'stop') {
            // keep what is built: the comp being filled when the click came is complete up to that layer
            if (target) startAt(target, target.numLayers - n0, at);
            if (!comp) comp = lastBuilt;
            LOG.unshift('Stopped by you at layer ' + PROG.n + ' of ' + PROG.total + ' — what was built so far is kept');
        } else if (cancelled === 'cancel') {
            // take everything out again: the new layers of the target comp, and the scene folder with its comps and pictures
            if (target) for (var d = target.numLayers - n0; d >= 1; d--) try { var dl = target.layer(1); dl.locked = false; dl.remove(); } catch (e2) {}
            try { FOLDERS.scene.remove(); } catch (e3) {}
            comp = target;
            mode = 'cancelled';
        }
        if (comp && cancelled !== 'cancel') try { comp.openInViewer(); } catch (e4) {}
        try {
            if (FOLDERS && FOLDERS.scene && cancelled !== 'cancel') {
                if (FOLDERS.scene.numItems === 0) FOLDERS.scene.remove();          // "Current" with nothing new for the project panel
                if (FOLDERS.top.numItems === 0) FOLDERS.top.remove();
            } else if (FOLDERS && FOLDERS.top.numItems === 0) FOLDERS.top.remove();
        } catch (e5) {}
        closeScratch(cancelled === 'cancel' ? target : comp);
        FOLDERS = null; lastBuilt = null;
        app.endUndoGroup();
        for (var fk in missingFonts) {
            var n = 0, names = [];
            for (var ln in missingFonts[fk].layers) { n++; if (names.length < 3) names.push('"' + ln + '"'); }
            LOG.unshift('Font "' + fk + '" is not installed — replaced with "' + missingFonts[fk].sub + '" (' + n + ' layer(s): ' +
                        names.join(', ') + (n > 3 ? '…' : '') + '). Install the font and import again for an exact match.');
        }
        writeProgress('done', '');
        PROG = null;
        return { comp: comp, mode: mode, log: LOG, secs: (new Date().getTime() - t0) / 1000 };
    }

    /** returns a converter sRGB -> project working space when one is needed and known */
    function colorChecks() {
        var conv = null;
        try {
            if (app.project.linearBlending) note('The project has "Blend Colors Using 1.0 Gamma" on — opacity and blend modes will mix differently than in Figma.');
            var ws = app.project.workingSpace;
            if (ws && ws !== 'None' && !/sRGB/i.test(ws)) {
                var g = ws.match(/gamma\s*(\d+(?:\.\d+)?)/i);
                if (g && /709/.test(ws)) {
                    // Rec.709 primaries are the sRGB ones: only the transfer curve differs -> exact
                    var gamma = parseFloat(g[1]);
                    conv = function (c) { return G.srgbToGamma(c, gamma); };
                } else note('Project working colour space is "' + ws + '" — Figma colours are sRGB and may shift.');
            }
        } catch (e) {}
        return conv;
    }

    var COLOR_KEYS = { color: 1, c0: 1, c1: 1, solid: 1 };
    function isRGB(v) { return v instanceof Array && v.length === 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number'; }
    /** every colour in the export, re-encoded for the project's working space */
    function recolor(o, fn) {
        if (!o || typeof o !== 'object') return;
        if (o instanceof Array) { for (var i = 0; i < o.length; i++) recolor(o[i], fn); return; }
        for (var k in o) {
            var v = o[k];
            if (COLOR_KEYS[k] && isRGB(v)) o[k] = fn(v);
            else if (k === 'colors' && v instanceof Array) { for (var j = 0; j < v.length; j++) if (isRGB(v[j])) v[j] = fn(v[j]); }
            else if (k !== 'png' && v && typeof v === 'object') recolor(v, fn);
        }
    }

    /* ----------------------------------------------------------- comps */

    function compSide(v, name) {
        v = Math.round(v);
        if (v > 30000) note('"' + name + '": larger than 30000 px — AE cannot do that, the comp was cropped');
        return Math.max(4, Math.min(30000, v));      // AE: 4..30000; content keeps its place from the top-left
    }

    var lastBuilt = null;      // the main comp of a "New Comp" import, as soon as it exists (Stop keeps it)
    function newComp(def, doc, main) {
        var c = app.project.items.addComp(def.name || 'comp',
            compSide(def.w, def.name), compSide(def.h, def.name),
            1, doc.duration || 10, doc.fps || 30);
        try { c.parentFolder = main ? FOLDERS.scene : subFolder('pre', 'Precomps'); } catch (e) {}
        if (main) lastBuilt = c;
        return c;
    }
    function buildComp(def, doc, main) {
        var c = newComp(def, doc, main);
        fillComp(c, def, doc);
        return c;
    }

    /** the first k layers of c start at time at (new layers of a "Current" import begin at the playhead) */
    function startAt(c, k, at) {
        for (var t = 1; t <= k; t++) {
            var nl = c.layer(t), lk = nl.locked;
            if (lk) nl.locked = false;
            nl.startTime = at;
            if (lk) nl.locked = true;
        }
    }

    /** builds def.layers into comp c (a new comp, or the active one in "Current" mode) */
    function fillComp(c, def, doc) {
        var ctx = { nulls: {}, kids: [] }, stop = null;
        groupCtx.push(ctx);
        // layers[0] is the bottom-most; each new AE layer lands on top
        for (var i = 0; i < def.layers.length && !stop; i++) {
            try { buildLayer(c, def.layers[i], doc); }
            catch (e) {
                if (e === CANCEL) stop = e;          // Stop / Cancel: finish this comp's bookkeeping, then unwind
                else note('Layer "' + def.layers[i].name + '": ' + e.toString() + ' (line ' + e.line + ')');
            }
        }
        groupCtx.pop();
        // flattened Figma groups: parent their layers to the group null (keeps every layer where it is)
        for (var k = 0; k < ctx.kids.length; k++) {
            var lay = ctx.kids[k][0], nl = ctx.nulls[ctx.kids[k][1]];
            if (!nl || lay.index === nl.index) continue;
            try {
                var lk = lay.locked;
                if (lk) lay.locked = false;
                lay.parent = nl;
                if (lk) lay.locked = true;
            } catch (e) { note('Could not parent "' + lay.name + '" to its group null: ' + e); }
        }
        if (stop) throw stop;
    }

    var groupCtx = [];
    var SCRATCH = null;
    function openScratch() {
        try {
            SCRATCH = app.project.items.addComp('Fig2AE · building…', 4, 4, 1, 1, 1);
            SCRATCH.openInViewer();
        } catch (e) { SCRATCH = null; }
    }
    /** back to the scratch comp after something had to be the active comp (gradient presets) */
    function showScratch() { if (SCRATCH) try { SCRATCH.openInViewer(); } catch (e) {} }
    function closeScratch(result) {
        if (!SCRATCH) return;
        try { if (result) result.openInViewer(); } catch (e) {}
        try { SCRATCH.remove(); } catch (e) {}
        SCRATCH = null;
    }
    var REF_TAG = 'fig2ae:reference';

    function activeComp() {
        var a = app.project.activeItem;
        return (a && a instanceof CompItem) ? a : null;
    }

    /** moves a top-level layer of the export (and the layers that travel with it) by dx, dy in comp space */
    function shiftLayer(L, dx, dy) {
        if (!L) return;
        if (L.pos) L.pos = [L.pos[0] + dx, L.pos[1] + dy];
        if (L.text && L.text.m) L.text.m = [L.text.m[0], L.text.m[1], L.text.m[2], L.text.m[3], L.text.m[4] + dx, L.text.m[5] + dy];   // text is placed through this matrix
        if (L.type === 'bgblur') shiftLayer(L.matte, dx, dy);       // the adjustment layer itself fills the comp
        else if (L.matte) shiftLayer(L.matte.layer, dx, dy);
    }

    /** panel settings: the server passes them as F2A_OPTS; a file run reads what the panel saved */
    function readOpts(doc) {
        var o = $.global.F2A_OPTS;
        if (!o) {
            try { if (app.settings.haveSetting('Fig2AE', 'opts')) o = eval('(' + app.settings.getSetting('Fig2AE', 'opts') + ')'); } catch (e) {}
        }
        o = o || {};
        if (!o.target && doc.target) o.target = doc.target;
        return o;
    }

    /** a layer and its matte are one unit: Stop/Cancel never lands between them (an unmatted picture or blur) */
    function withMatte(fn) {
        if (PROG) PROG.hold++;
        try { return fn(); } finally { if (PROG) PROG.hold--; }
    }

    function buildLayer(c, L, doc) {
        progress(L);
        if (L.type === 'bgblur') return buildBgBlur(c, L, doc);

        var lay, pending = null;
        if (L.type === 'null') {
            lay = c.layers.addNull();
            lay.comment = 'fig2ae:group';            // "Delete group layers" in the panel removes exactly these
            lay.label = 0;
        }
        else if (L.type === 'shape') lay = buildShape(c, L);
        else if (L.type === 'text') lay = buildText(c, L);
        else if (L.type === 'image') lay = buildImage(c, L);
        else if (L.type === 'precomp') {
            // Stop inside a precomp: the part built so far still goes into place, then the import unwinds
            var pc = newComp(L.comp, doc, false);
            try { fillComp(pc, L.comp, doc); } catch (e) { if (e !== CANCEL) throw e; pending = e; }
            lay = c.layers.add(pc);
        }
        if (!lay) return null;

        lay.name = L.name;
        var ctx = groupCtx[groupCtx.length - 1];
        if (ctx) {
            if (L.type === 'null') ctx.nulls[L.gid] = lay;
            if (L.group) ctx.kids.push([lay, L.group]);
        }
        var anchor = L.anchor, pos = L.pos, scale = L.scale;
        if (L.type === 'image') {
            anchor = [L.png.w / 2, L.png.h / 2];                 // layer space = source pixels
            scale = [scale[0] / L.png.scale, scale[1] / L.png.scale];
        } else if (L.type === 'text' && lastInk) {
            anchor = lastInk.anchor; pos = lastInk.pos;
        }
        lastInk = null;
        lay.transform.anchorPoint.setValue(anchor);
        lay.transform.position.setValue(pos);
        lay.transform.rotation.setValue(L.rot);
        lay.transform.scale.setValue(scale);
        lay.transform.opacity.setValue(clamp(L.opacity, 0, 100));
        lay.blendingMode = layerBlend(L.blend);
        if (L.hidden) lay.enabled = false;

        if (L.fx) addGradientFx(lay, L);               // colours first, then shear, then shadows/blur act on the result
        if (L.shear) addShear(lay, L);
        var fx = L.effects || [];
        for (var i = 0; i < fx.length; i++) addEffect(lay, fx[i]);

        if (L.matte) {
            var m = withMatte(function () { return buildLayer(c, L.matte.layer, doc); });     // lands directly above
            if (m) setMatte(lay, m, L.matte.mode);
        }
        if (L.guide) { lay.guideLayer = true; lay.comment = REF_TAG; }   // reference frame: visible in the viewer, never rendered
        if (L.locked) lay.locked = true;    // last: a locked layer rejects edits
        if (pending) throw pending;
        return lay;
    }

    /**
     * Gradient as AE effects (see linearFx in the plugin): Gradient Ramp,
     * 4-Color Gradient, Linear Wipe. Effect points of shape/text layers live in
     * COMP space, so every point is written as toComp(<layer-space point>): the
     * gradient follows the layer when it is moved or animated.
     */
    function addGradientFx(lay, L) {
        var F = L.fx, fx = lay.property('ADBE Effect Parade');
        var toLayer = function (q) { return q; };                       // shape layer space = node space
        if (L.type === 'text' && !L.outlined) {
            // the layer maps its anchor to the node point under its position, with the node's own
            // linear map (rotation, scale, shear) -> text layer space is node space shifted
            var a = lay.transform.anchorPoint.value, c0 = G.apply(G.inv(L.text.m), lay.transform.position.value);
            toLayer = function (q) { return [a[0] + q[0] - c0[0], a[1] + q[1] - c0[1]]; };
        }
        function lit(q) { var v = toLayer(q); return '[' + v[0] + ', ' + v[1] + ']'; }

        if (F.ramp) {
            var e = fx.addProperty('ADBE Ramp');
            e.property(1).setValue(toLayer(F.ramp.start));
            e.property(2).setValue(F.ramp.c0);
            e.property(3).setValue(toLayer(F.ramp.end));
            e.property(4).setValue(F.ramp.c1);
            e.property(5).setValue(F.ramp.shape);                         // 1 linear, 2 radial
            e.property(1).expression = 'toComp(value)';
            e.property(3).expression = 'toComp(value)';
        }
        if (F.four) {
            // setValue on 4-Color points breaks AE's scripting (tested in 26.2): points go in expressions
            var f4 = fx.addProperty('ADBE 4ColorGradient');
            for (var k = 0; k < 4; k++) {
                f4.property('ADBE 4ColorGradient-000' + (1 + 2 * k)).expression = 'toComp(' + lit(F.four.points[k]) + ')';
                f4.property('ADBE 4ColorGradient-000' + (2 + 2 * k)).setValue(F.four.colors[k]);
            }
            // Blend works in pixels: best match to Figma's piecewise-linear ramp measured in AE 26.2 at
            // Blend 30 for a 320 px gradient (mean error 0.06; default 100: 0.15) -> 0.094 * length.
            // setValue on Blend kills the script too, so an expression again.
            var P0 = F.four.points[0], P3 = F.four.points[3], len;
            if (L.type === 'text' && !L.outlined) { var q0 = G.apply(L.text.m, P0), q3 = G.apply(L.text.m, P3); len = Math.sqrt(Math.pow(q3[0] - q0[0], 2) + Math.pow(q3[1] - q0[1], 2)); }
            else len = Math.sqrt(Math.pow(P3[0] - P0[0], 2) + Math.pow(P3[1] - P0[1], 2)) * Math.abs(lay.transform.scale.value[0]) / 100;
            f4.property('ADBE 4ColorGradient-0009').expression = String(Math.max(1, Math.min(100, Math.round(0.094 * len * 10) / 10)));
            note('"' + L.name + '": a 3–4 colour gradient became 4-Color Gradient — it blends by distance, close but not exact');
        }
        if (F.wipe) {
            // Linear Wipe, measured in AE 26.2: n = (sin a, -cos a); edge = lo + C*(hi-lo) over the comp
            // corners projected on n; feather is gaussian, sigma = 0.39*F -> F = 1.02 * fade length
            var w = fx.addProperty('ADBE Linear Wipe');
            var pts = 'var A = toComp(' + lit(F.wipe.from) + '), B = toComp(' + lit(F.wipe.to) + '), d = sub(B, A);';
            w.property(1).expression = pts +
                'var n = normalize(d), m = add(A, mul(d, 0.5)), W = thisComp.width, H = thisComp.height;' +
                'var ps = [0, dot([W, 0], n), dot([0, H], n), dot([W, H], n)];' +
                'var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);' +
                '(dot(m, n) - lo) / (hi - lo) * 100;';
            w.property(2).expression = pts + 'radiansToDegrees(Math.atan2(d[0], -d[1]));';
            w.property(3).expression = pts + 'length(d) * 1.023;';
        }
    }

    function setMatte(lay, matte, mode) {
        var t = mode === 'LUMA' ? TrackMatteType.LUMA : TrackMatteType.ALPHA;
        if (typeof lay.setTrackMatte === 'function') lay.setTrackMatte(matte, t);   // AE 23+
        else lay.trackMatteType = t;                                               // matte is the layer above
    }

    /** Figma background blur: adjustment layer, blurred, matted by the node outline */
    function buildBgBlur(c, L, doc) {
        var adj = c.layers.addSolid([1, 1, 1], L.name, c.width, c.height, 1);
        adj.adjustmentLayer = true;
        var b = adj.property('ADBE Effect Parade').addProperty('ADBE Gaussian Blur 2');
        b.property(1).setValue(L.sigma * AE_BLUR_PER_SIGMA);
        try { b.property(3).setValue(1); } catch (e) {}           // repeat edge pixels
        if (L.hidden) adj.enabled = false;
        var m = withMatte(function () { return buildLayer(c, L.matte, doc); });
        if (m) setMatte(adj, m, 'ALPHA');
        return adj;
    }

    /* ---------------------------------------------------------- shapes */

    // AE shape Fill/Stroke "Blend Mode" dropdown indices (menu separators count) — from AEUX
    var SHAPE_BLEND = { DARKEN: 3, MULTIPLY: 4, COLOR_BURN: 5, LINEAR_BURN: 6, LIGHTEN: 9, SCREEN: 10,
        COLOR_DODGE: 11, LINEAR_DODGE: 12, OVERLAY: 15, SOFT_LIGHT: 16, HARD_LIGHT: 17, DIFFERENCE: 23,
        EXCLUSION: 24, HUE: 26, SATURATION: 27, COLOR: 28, LUMINOSITY: 29 };

    function buildShape(c, L) {
        var lay = c.layers.addShape();
        // AE draws the FIRST group on top -> add the top-most paint first
        for (var gi = L.groups.length - 1; gi >= 0; gi--) {
            var Gr = L.groups[gi], P = Gr.paint;
            if (Gr.single) { addOutlineGroup(lay, Gr); continue; }
            for (var pi = 0; pi < Gr.paths.length; pi++) {
                var subs = G.parsePath(Gr.paths[pi].d);
                if (!subs.length) continue;
                var evenOdd = Gr.paths[pi].evenOdd;

                // elliptical radial gradient: circle in group space, ellipse via group transform
                var frame = P.kind === 'radial' ? radialFrame(P) : null;
                if (frame && frame.groupM) subs = G.transformSubs(subs, G.inv(frame.groupM));

                var root = lay.property('ADBE Root Vectors Group');
                var grp = root.addProperty('ADBE Vector Group');
                var gIndex = root.numProperties;
                grp.name = (Gr.stroke ? 'stroke ' : 'fill ') + (gi + 1) + (Gr.paths.length > 1 ? '.' + (pi + 1) : '');
                var items = grp.property('ADBE Vectors Group');
                if (Gr.param && Gr.paths.length === 1 && !(frame && frame.groupM)) addParametric(items, Gr.param);
                else addPaths(items, subs);
                if (Gr.hole) addHole(items, Gr.hole);
                if (frame && frame.groupM) {
                    var tg = grp.property('ADBE Vector Transform Group');
                    tg.property('ADBE Vector Position').setValue(frame.center);
                    tg.property('ADBE Vector Rotation').setValue(frame.rot);
                    tg.property('ADBE Vector Scale').setValue([100, frame.ratio * 100]);
                }

                if (Gr.stroke && Gr.stroke.offset) {
                    // inside / outside stroke: the outline moved by half the weight, then a normal stroke on it
                    var op = items.addProperty('ADBE Vector Filter - Offset');
                    op.property('ADBE Vector Offset Amount').setValue(Gr.stroke.offset);
                    try { op.property('ADBE Vector Offset Line Join').setValue({ MITER: 1, ROUND: 2, BEVEL: 3 }[Gr.stroke.join] || 1); } catch (e) {}
                    try { op.property('ADBE Vector Offset Miter Limit').setValue(Gr.stroke.miter || 4); } catch (e) {}
                }
                if (Gr.stroke) addStroke(items, P, Gr.stroke);
                else if (P.kind === 'solid') addFill(items, P, evenOdd);
                else addGradient(c, lay, items, P, evenOdd, frame, gIndex);
            }
        }
        return lay;
    }

    /**
     * Vector drop shadow (Figma spread): every path in ONE group so overlaps don't
     * double the alpha, grown by Offset Paths, moved by the group position — all editable.
     */
    function addOutlineGroup(lay, Gr) {
        var grp = lay.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
        grp.name = 'shadow';
        var items = grp.property('ADBE Vectors Group');
        for (var p = 0; p < Gr.paths.length; p++) addPaths(items, G.parsePath(Gr.paths[p].d));
        if (Gr.spread) items.addProperty('ADBE Vector Filter - Offset').property('ADBE Vector Offset Amount').setValue(Gr.spread);
        addFill(items, Gr.paint, Gr.paths.length === 1 && Gr.paths[0].evenOdd);
        if (Gr.offset) grp.property('ADBE Vector Transform Group').property('ADBE Vector Position').setValue(Gr.offset);
    }

    /** "Detect parametric shapes": AE Rect / Ellipse instead of a bezier path (layer space = node space) */
    function addParametric(items, P) {
        var w = P.size[0], h = P.size[1];
        if (P.kind === 'ellipse') {
            var e = items.addProperty('ADBE Vector Shape - Ellipse');
            e.property('ADBE Vector Ellipse Size').setValue([w, h]);
            e.property('ADBE Vector Ellipse Position').setValue([w / 2, h / 2]);
            return;
        }
        var r = items.addProperty('ADBE Vector Shape - Rect');
        r.property('ADBE Vector Rect Size').setValue([w, h]);
        r.property('ADBE Vector Rect Position').setValue([w / 2, h / 2]);
        r.property('ADBE Vector Rect Roundness').setValue(P.r || 0);
    }

    function addPaths(items, subs) {
        for (var si = 0; si < subs.length; si++) {
            var sh = new Shape();
            sh.vertices = subs[si].v;
            sh.inTangents = subs[si].i;
            sh.outTangents = subs[si].o;
            sh.closed = subs[si].closed;
            items.addProperty('ADBE Vector Shape - Group').property('ADBE Vector Shape').setValue(sh);
        }
    }

    /**
     * Inner-shadow hole: the node outline in its own sub-group, moved by the
     * shadow offset (group position) and shrunk by spread (Offset Paths) — both
     * stay editable. The even-odd fill of the outer group punches it out.
     */
    function addHole(items, hole) {
        var hg = items.addProperty('ADBE Vector Group');
        hg.name = 'shape (shadow offset)';
        var hi = hg.property('ADBE Vectors Group');
        for (var p = 0; p < hole.paths.length; p++) addPaths(hi, G.parsePath(hole.paths[p].d));
        if (hole.spread) {
            var off = hi.addProperty('ADBE Vector Filter - Offset');
            off.property('ADBE Vector Offset Amount').setValue(-hole.spread);
        }
        hg.property('ADBE Vector Transform Group').property('ADBE Vector Position').setValue(hole.offset);
    }

    /**
     * Radial gradient in AE terms. Figma gives centre + 2x2 map of the unit
     * circle; AE radial gradients are circles, so an ellipse becomes a circle in
     * a group whose transform squashes/rotates it (paths get the inverse).
     */
    function radialFrame(P) {
        var d = G.svd2(P.m);
        if (d.s1 < 1e-6) return { center: P.center, radius: 0, groupM: null };
        var circle = Math.abs(d.s1 - d.s2) < 1e-3 * d.s1;
        if (circle) return { center: P.center, radius: d.s1, groupM: null };
        var ratio = d.s2 / d.s1;
        if (Math.abs(ratio) < 1e-4) ratio = ratio < 0 ? -1e-4 : 1e-4;   // degenerate ellipse: keep invertible
        var r = d.rot * Math.PI / 180, co = Math.cos(r), sn = Math.sin(r);
        // group: x_layer = center + R(rot) * diag(1, ratio) * x_group
        var groupM = [co, sn, -sn * ratio, co * ratio, P.center[0], P.center[1]];
        return { center: P.center, radius: d.s1, rot: d.rot, ratio: ratio, groupM: groupM };
    }

    function addFill(items, P, evenOdd) {
        var f = items.addProperty('ADBE Vector Graphic - Fill');
        f.property('ADBE Vector Fill Color').setValue(P.color);
        f.property('ADBE Vector Fill Opacity').setValue(clamp(P.opacity, 0, 100));
        try { f.property('ADBE Vector Fill Rule').setValue(evenOdd ? 2 : 1); } catch (e) {}
        shapeBlend(f, P.blend);
        return f;
    }

    function addStroke(items, P, st) {
        var s = items.addProperty('ADBE Vector Graphic - Stroke');
        s.property('ADBE Vector Stroke Color').setValue(P.color);
        s.property('ADBE Vector Stroke Opacity').setValue(clamp(P.opacity, 0, 100));
        s.property('ADBE Vector Stroke Width').setValue(st.width);
        var join = { MITER: 1, ROUND: 2, BEVEL: 3 }[st.join] || 1;
        s.property('ADBE Vector Stroke Line Cap').setValue({ NONE: 1, ROUND: 2, SQUARE: 3 }[st.cap] || 1);
        s.property('ADBE Vector Stroke Line Join').setValue(join);
        if (join === 1) s.property('ADBE Vector Stroke Miter Limit').setValue(st.miter);
        if (st.dash && st.dash.length) {
            // Figma dashPattern [dash, gap, …] -> AE Dashes (up to 3 pairs, editable and animatable)
            try {
                var ds = s.property('ADBE Vector Stroke Dashes');
                for (var di = 0; di < st.dash.length && di < 6; di++) {
                    var nm = (di % 2 ? 'ADBE Vector Stroke Gap ' : 'ADBE Vector Stroke Dash ') + (Math.floor(di / 2) + 1);
                    ds.addProperty(nm).setValue(Math.max(0, st.dash[di]));
                }
                // Offset stays hidden (setValue throws) until it is added, unlike in the UI
                if (st.dashOffset) ds.addProperty('ADBE Vector Stroke Offset').setValue(st.dashOffset);
            } catch (e) { note('Could not set the dashes of a stroke: ' + e); }
        }
        shapeBlend(s, P.blend);
        return s;
    }

    function shapeBlend(prop, blend) {
        if (!blend || blend === 'NORMAL' || blend === 'PASS_THROUGH') return;
        var v = SHAPE_BLEND[blend];
        if (!v) { note('Fill blend mode ' + blend + ' does not exist in AE — Normal'); return; }
        try { prop.property('ADBE Vector Blend Mode').setValue(v); } catch (e) { note('Could not set the fill blend mode: ' + e); }
    }

    function addGradient(c, lay, items, P, evenOdd, frame, gIndex) {
        var f = items.addProperty('ADBE Vector Graphic - G-Fill');
        var iIndex = items.numProperties;
        f.property('ADBE Vector Fill Opacity').setValue(clamp(P.opacity, 0, 100));
        try { f.property('ADBE Vector Fill Rule').setValue(evenOdd ? 2 : 1); } catch (e) {}
        shapeBlend(f, P.blend);
        if (P.kind === 'linear') {
            f.property('ADBE Vector Grad Type').setValue(1);
            f.property('ADBE Vector Grad Start Pt').setValue(P.start);
            f.property('ADBE Vector Grad End Pt').setValue(P.end);
        } else {
            f.property('ADBE Vector Grad Type').setValue(2);
            var ctr = frame.groupM ? [0, 0] : frame.center;      // group space when squashed
            f.property('ADBE Vector Grad Start Pt').setValue(ctr);
            f.property('ADBE Vector Grad End Pt').setValue([ctr[0] + Math.max(frame.radius, 0.01), ctr[1]]);
        }
        applyGradientColors(c, lay, f, P.stops, gIndex, iIndex);
    }

    /** shape gradient colours are not scriptable; an .ffx preset is (see geom.jsx) */
    function applyGradientColors(c, lay, gfill, stops, gIndex, iIndex) {
        var file = new File(Folder.temp.fsName + '/fig2ae_grad_' + (++gradSeq) + '.ffx');
        writeBinary(file, G.gradientFfx(stops, gIndex - 1, iIndex - 1));
        try {
            if (SCRATCH || !openedComps[c.id]) { c.openInViewer(); openedComps[c.id] = true; }  // presets apply to the active comp
            var sel = c.selectedLayers;
            for (var i = 0; i < sel.length; i++) sel[i].selected = false;
            var props = c.selectedProperties;
            for (var j = 0; j < props.length; j++) try { props[j].selected = false; } catch (e) {}
            gfill.selected = true;
            var before = lay.property('ADBE Root Vectors Group').numProperties;
            lay.applyPreset(file);
            lay.selected = false;
            if (lay.property('ADBE Root Vectors Group').numProperties !== before) {
                note('Layer "' + lay.name + '": the gradient preset landed in a new group — check the colours');
            }
        } catch (e) {
            note('Layer "' + lay.name + '": could not apply the gradient colours (' + e + ')');
        } finally {
            try { file.remove(); } catch (e2) {}
            showScratch();
        }
    }

    /* ------------------------------------------------------------ text */

    function norm(s) { return String(s).toLowerCase().replace(/[\s_\-]+/g, ''); }

    /** Font object, null if not installed, undefined if this AE has no font API */
    function findFont(family, style) {
        var key = family + '|' + style;
        if (key in fontCache) return fontCache[key];
        var res;
        try {
            if (!app.fonts) throw 0;
            var r = app.fonts.getFontsByFamilyNameAndStyleName(family, style);
            res = (r && r.length) ? r[0] : null;
            if (!res) {
                var all = app.fonts.allFonts, nf = norm(family), ns = norm(style);  // array of family groups
                for (var i = 0; i < all.length && !res; i++) {
                    for (var j = 0; j < all[i].length; j++) {
                        var f = all[i][j];
                        if (norm(f.familyName) === nf && norm(f.styleName) === ns) { res = f; break; }
                    }
                }
            }
        } catch (e) { res = undefined; }
        fontCache[key] = res;
        return res;
    }

    function setFont(target, seg, font) {
        if (font) {
            try { target.fontObject = font; } catch (e) { target.font = font.postScriptName; }
        } else if (font === undefined) {
            target.font = seg.family.replace(/\s+/g, '') + '-' + seg.style.replace(/\s+/g, '');   // AE < 24: best guess
        }
    }

    /** one value AE rejects must not kill the whole layer: retry rounded, else report */
    function put(target, key, v, L) {
        try { target[key] = v; return; } catch (e) {}
        try { target[key] = Math.round(v); } catch (e2) { note('"' + L.name + '": AE rejected ' + key + ' = ' + v); }
    }

    function setCharStyle(target, seg, font, L) {
        try { setFont(target, seg, font); } catch (e) { note('"' + L.name + '": could not set font ' + seg.family + ' ' + seg.style); }
        put(target, 'fontSize', seg.size, L);
        put(target, 'tracking', Math.round(seg.tracking), L);   // AE takes whole 1/1000 em only (< 0.0005 em off)
        if (seg.leading === null || seg.leading === undefined) target.autoLeading = true;
        else { target.autoLeading = false; put(target, 'leading', seg.leading, L); }
        // fill:false = characters drawn by another layer (gradient/picture text parts)
        target.applyFill = seg.fill !== false;
        target.fillColor = seg.color;
    }

    // stand-ins for fonts that are not installed: the first family that exists wins
    var FALLBACK_FAMILIES = ['Arial', 'Segoe UI', 'Helvetica', 'Tahoma'];

    /** closest installed default font for a Figma style name (weight + italic kept where possible) */
    function fallbackFont(style) {
        var italic = /italic|oblique/i.test(style);
        var bold = /bold|black|heavy/i.test(style);                     // Semi/Extra/Ultra Bold, Black, Heavy
        var mapped = (bold ? 'Bold' : 'Regular') + (italic ? ' Italic' : '');
        if (mapped === 'Regular Italic') mapped = 'Italic';
        for (var i = 0; i < FALLBACK_FAMILIES.length; i++) {
            var f = findFont(FALLBACK_FAMILIES[i], style) || findFont(FALLBACK_FAMILIES[i], mapped) ||
                    findFont(FALLBACK_FAMILIES[i], 'Regular');
            if (f) return f;
        }
        return null;                                                     // keep AE's default
    }

    // icon fonts draw icons from ligatures ("star" -> a star glyph): a stand-in font would show the words
    var ICON_FONT = /icons?\b|symbols|awesome|glyph|ionicons|phosphor|lucide|feather|tabler|remix/i;

    function buildText(c, L) {
        var T = L.text, segs = T.segs, fonts = [], substituted = false, i;
        for (i = 0; i < segs.length; i++) {
            fonts[i] = findFont(segs[i].family, segs[i].style);
            if (fonts[i] === null && ICON_FONT.test(segs[i].family) && T.outline && T.outline.length) {
                note('"' + L.name + '": icon font "' + segs[i].family + '" is not installed — the icon was transferred as Figma outlines (looks exact)');
                L.outlined = true;
                var on = segs[0];
                for (var q = 0; q < segs.length; q++) if (segs[q].fill !== false) { on = segs[q]; break; }
                return buildShape(c, { groups: [{ paths: T.outline, paint: { kind: 'solid', color: on.color, opacity: on.alpha, blend: 'NORMAL' } }] });
            }
            if (fonts[i] === null) {
                fonts[i] = fallbackFont(segs[i].style);
                substituted = true;
                var key = segs[i].family + ' ' + segs[i].style;
                var m = missingFonts[key] || (missingFonts[key] = { sub: fonts[i] ? fonts[i].familyName + ' ' + fonts[i].styleName : 'the AE default font', layers: {} });
                m.layers[L.name] = 1;
            }
            if (fonts[i] === undefined) note('AE older than 24.0: font "' + segs[i].family + ' ' + segs[i].style + '" set by a guessed PostScript name');
        }

        var lay = T.box ? c.layers.addBoxText([L.size[0], L.size[1]]) : c.layers.addText();
        var prop = lay.property('ADBE Text Properties').property('ADBE Text Document');
        var td = prop.value;
        try { td.resetCharStyle(); td.resetParagraphStyle(); } catch (e) {}
        td.text = T.chars;
        setCharStyle(td, segs[0], fonts[0], L);
        td.justification = { LEFT: ParagraphJustification.LEFT_JUSTIFY, CENTER: ParagraphJustification.CENTER_JUSTIFY,
                             RIGHT: ParagraphJustification.RIGHT_JUSTIFY, JUSTIFIED: ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT }[T.align]
                           || ParagraphJustification.LEFT_JUSTIFY;
        if (T.stroke) {
            td.applyStroke = true; td.strokeColor = T.stroke.color; put(td, 'strokeWidth', T.stroke.width, L);
            td.strokeOverFill = T.stroke.overFill;
        } else td.applyStroke = false;
        try { if (T.paraSpacing) td.spaceAfter = T.paraSpacing; } catch (e) {}
        try { if (T.indent) td.firstLineIndent = T.indent; } catch (e) {}
        if (T.box) {
            td.boxTextSize = [L.size[0], L.size[1]];
            try { td.boxInsetSpacing = 0; } catch (e) {}                       // 24.6+: AE pads boxes by default
            try {
                td.boxVerticalAlignment = { CENTER: BoxVerticalAlignment.CENTER, BOTTOM: BoxVerticalAlignment.BOTTOM }[T.valign] || BoxVerticalAlignment.TOP;
            } catch (e) {}
        }
        prop.setValue(td);

        // per-character styles (AE 24.3+)
        if (segs.length > 1) {
            td = prop.value;
            if (typeof td.characterRange === 'function') {
                for (i = 0; i < segs.length; i++) {
                    if (segs[i].end > segs[i].start) setCharStyle(td.characterRange(segs[i].start, segs[i].end), segs[i], fonts[i], L);
                }
                prop.setValue(td);
            } else note('"' + L.name + '": AE older than 24.3 — mixed styles reduced to the first run');
        }

        // overflowing box text silently hides lines -> grow the box until it fits
        if (T.box) {
            for (var k = 0; k < 6; k++) {
                td = prop.value;
                var over = false;
                try { over = td.boxOverflow; } catch (e) { break; }
                if (!over) break;
                td.boxTextSize = [L.size[0], td.boxTextSize[1] * 1.25 + 4];
                prop.setValue(td);
            }
        }

        // AE text has no per-character opacity: one value for the filled characters
        var alpha = null;
        for (i = 0; i < segs.length; i++) {
            if (segs[i].fill === false) continue;
            if (alpha === null) alpha = segs[i].alpha;
            else if (Math.abs(segs[i].alpha - alpha) > 0.5) note('"' + L.name + '": text runs have different opacity — the first one is used');
        }
        if (alpha !== null && alpha < 100) L.opacity = L.opacity * alpha / 100;

        placeByInk(lay, L, substituted);
        return lay;
    }

    /**
     * Put AE's glyph box exactly where Figma's glyph box is. Both apps measure
     * their own glyphs, so font metrics, box padding and baseline rules cancel out.
     * Horizontally the paragraph's alignment edge is matched, so a substitute
     * font of a different width still starts (or ends) where the original did.
     */
    function placeByInk(lay, L, substituted) {
        var T = L.text;
        var subs = [];
        for (var p = 0; p < (T.outline || []).length; p++) subs = subs.concat(G.parsePath(T.outline[p].d));
        var fig = subs.length ? G.bounds(subs) : null;
        var r = null;
        try { r = lay.sourceRectAtTime(0, false); } catch (e) {}
        if (!fig || !r || r.width <= 0) return;      // whitespace etc: keep box placement

        var k = T.align === 'CENTER' ? 0.5 : (T.align === 'RIGHT' ? 1 : 0);
        // underline/strike-through are in Figma's outlines but AE text has none: match tops instead of centres
        var ky = T.deco ? 0 : 0.5;
        lastInk = {
            anchor: [r.left + r.width * k, r.top + r.height * ky],
            pos: G.apply(T.m, [fig.x + fig.w * k, fig.y + fig.h * ky])
        };

        if (substituted || T.deco) return;             // size differs by design; reported elsewhere
        var tol = Math.max(1.5, 0.04 * Math.max(fig.w, fig.h));
        if (Math.abs(r.width - fig.w) > tol || Math.abs(r.height - fig.h) > tol) {
            note('"' + L.name + '": AE renders this text differently (' + Math.round(r.width) + '×' + Math.round(r.height) +
                 ' instead of ' + Math.round(fig.w) + '×' + Math.round(fig.h) + ') — different line breaks or font version');
        }
    }

    /* ----------------------------------------------------------- image */

    /** pictures of a plugin-saved .jsx live in a comment at its end (see build.js makeJsx) */
    var payload = null;
    function pictureB64(png) {
        if (png.b64) return png.b64;                                   // standalone .json import
        if (payload === null) {
            payload = [];
            var me = new File($.fileName);
            me.encoding = 'UTF-8';
            if (me.open('r')) {
                var s = me.read();
                me.close();
                var a = s.lastIndexOf('/*F2A-PAYLOAD'), b = s.lastIndexOf('F2A-PAYLOAD-END*/');
                if (a >= 0 && b > a) payload = s.substring(s.indexOf('\n', a) + 1, b).split(/\r?\n/);
            }
        }
        return payload[png.ref] || '';
    }

    /**
     * base64 -> file with the OS decoder (certutil / base64): decoding megabytes
     * byte by byte in ExtendScript takes minutes. JS decoder only as a fallback.
     */
    function writeBase64(file, b64) {
        var tmp = new File(file.fsName + '.b64');
        tmp.encoding = 'BINARY';
        tmp.open('w'); tmp.write(b64); tmp.close();
        try {
            if (file.exists) file.remove();
            if ($.os.indexOf('Windows') >= 0) system.callSystem('certutil -f -decode "' + tmp.fsName + '" "' + file.fsName + '"');
            else system.callSystem('base64 -D -i ' + G.shellQuote(tmp.fsName) + ' -o ' + G.shellQuote(file.fsName));
        } catch (e) {}
        tmp.remove();
        if (!file.exists || file.length === 0) writeBinary(file, G.b64decode(b64));
    }

    function buildImage(c, L) {
        var key = L.png.ref !== undefined ? 'ref' + L.png.ref
                : L.png.b64.length + ':' + L.png.b64.substring(0, 64) + L.png.b64.substring(L.png.b64.length - 64);
        var item = imgCache[key];
        if (!item) {
            var file = new File(assets.fsName + '/' + sanitize(L.name) + '_' + (++imgSeq) + '.' + (L.png.ext === 'jpg' ? 'jpg' : 'png'));
            writeBase64(file, pictureB64(L.png));
            var io = new ImportOptions(file);
            io.importAs = ImportAsType.FOOTAGE;
            item = app.project.importFile(io);
            try { if (FOLDERS) item.parentFolder = subFolder('img', 'Images'); } catch (e) {}
            try { item.mainSource.alphaMode = AlphaMode.STRAIGHT; } catch (e) {}   // PNG alpha is straight
            imgCache[key] = item;
        }
        return c.layers.add(item);
    }

    function sanitize(s) { return String(s).replace(/[^\w\dА-Яа-яЁё\-_]+/g, '_').substring(0, 30) || 'img'; }

    function writeBinary(file, str) {
        file.encoding = 'BINARY';
        file.lineFeed = 'Unix';                  // bytes stay as they are on every OS
        if (!file.open('w')) throw new Error('cannot write ' + file.fsName);
        file.write(str);
        file.close();
    }

    /* --------------------------------------------------------- effects */

    // Transform effect, measured in AE 26.2: Skew Axis 0 shears vertically; Skew Axis 90 gives
    // x' = x - tan(Skew) * (y - anchor.y). Figma's x' = x + t*y -> Skew = -atan(t), axis 90.
    // The axis turns the other way than layer rotation: a layer rotated by r needs axis 90 - r.
    var SKEW_SIGN = -1, SKEW_AXIS = 90, SKEW_MAX = 70;

    /**
     * Figma shear (a scaled group with rotated children gets it): the layer keeps
     * rotation + scale (R S), the shear Sh = [[1, t], [0, 1]] is a Transform effect
     * about the anchor, before shadows/blur. Pictures/precomps run effects in layer
     * space: Sh as is. Shape/text layers run them in comp space (after R S), where
     * the same map is R S Sh (R S)^-1: a shear along the rotated x axis by t*sx/sy.
     */
    function addShear(lay, L) {
        var inComp = L.type === 'shape' || L.type === 'text';
        var t = inComp ? L.shear * L.scale[0] / L.scale[1] : L.shear;
        var deg = Math.atan(t) * 180 / Math.PI;
        if (Math.abs(deg) > SKEW_MAX) {
            note('"' + L.name + '": shear ' + Math.round(deg) + '° exceeds the AE limit (' + SKEW_MAX + '°) — clamped');
            deg = deg < 0 ? -SKEW_MAX : SKEW_MAX;
        }
        var tr = lay.property('ADBE Effect Parade').addProperty('ADBE Geometry2');
        var a = lay.transform.anchorPoint.value, p = [a[0], a[1]];
        tr.property(1).setValue(p);
        tr.property(2).setValue(p);
        if (inComp) {
            tr.property(1).expression = 'toComp(value)';
            tr.property(2).expression = 'toComp(value)';
        }
        tr.property(6).setValue(SKEW_SIGN * deg);
        tr.property(7).setValue(SKEW_AXIS - (inComp ? L.rot : 0));
        tr.name = 'Shear (from Figma)';
    }

    function addEffect(lay, e) {
        var fx = lay.property('ADBE Effect Parade');
        if (e.type === 'SHADOW') {
            var d = fx.addProperty('ADBE Drop Shadow');   // params by index: language-independent
            d.property(1).setValue(e.color);
            d.property(2).setValue(clamp(e.opacity / 100 * 255, 0, 255));
            d.property(3).setValue(e.dir);
            d.property(4).setValue(e.dist);
            d.property(5).setValue(shadowSoftness(e.sigma));
        } else if (e.type === 'BLUR') {
            var b = fx.addProperty('ADBE Gaussian Blur 2');
            b.property(1).setValue(e.sigma * AE_BLUR_PER_SIGMA);
            // edges must blur outward like Figma's; "repeat edge pixels" would keep them hard
            // wherever the shape touches its layer bounds
            b.property(3).setValue(0);
        } else if (e.type === 'BOXBLUR') {
            // pictures: (Fast) Box Blur, 3 iterations ~ Gaussian; radius from the AE calibration above
            try {
                var bb = fx.addProperty('ADBE Box Blur2');
                bb.property(1).setValue(boxRadius(e.sigma));
                bb.property(2).setValue(3);
                try { bb.property(4).setValue(0); } catch (e1) {}               // repeat edge pixels off
            } catch (e2) {
                note('Box Blur unavailable — Gaussian Blur used');
                addEffect(lay, { type: 'BLUR', sigma: e.sigma });
            }
        } else if (e.type === 'TILE') {
            // Figma TILE fill: Motion Tile repeats the picture, the layer itself stays one tile
            try {
                var t = fx.addProperty('ADBE Tile');
                t.property(4).setValue(Math.min(e.nx * 100, 10000));               // output width %
                t.property(5).setValue(Math.min(e.ny * 100, 10000));               // output height %
            } catch (e3) { note('Motion Tile unavailable — the tile is shown once'); }
        }
    }

    /* ----------------------------------------------------------- misc */

    function layerBlend(b) {
        var m = {
            DARKEN: BlendingMode.DARKEN, MULTIPLY: BlendingMode.MULTIPLY, COLOR_BURN: BlendingMode.COLOR_BURN,
            LINEAR_BURN: BlendingMode.LINEAR_BURN, LIGHTEN: BlendingMode.LIGHTEN, SCREEN: BlendingMode.SCREEN,
            COLOR_DODGE: BlendingMode.COLOR_DODGE, LINEAR_DODGE: BlendingMode.LINEAR_DODGE,
            OVERLAY: BlendingMode.OVERLAY, SOFT_LIGHT: BlendingMode.SOFT_LIGHT, HARD_LIGHT: BlendingMode.HARD_LIGHT,
            DIFFERENCE: BlendingMode.DIFFERENCE, EXCLUSION: BlendingMode.EXCLUSION,
            HUE: BlendingMode.HUE, SATURATION: BlendingMode.SATURATION, COLOR: BlendingMode.COLOR,
            LUMINOSITY: BlendingMode.LUMINOSITY
        };
        return m[b] || BlendingMode.NORMAL;
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    function report(doc, res) {
        var all = res.log.concat(doc.warnings || []);
        var head = res.comp ? ('Done in ' + res.secs.toFixed(1) + ' s — comp "' + res.comp.name + '" ' + res.comp.width + '×' + res.comp.height)
                            : 'Import not finished';
        if (!all.length) { alert(head + '\nEverything transferred 1:1, no warnings.'); return; }

        var w = new Window('dialog', 'Fig2AE');
        w.orientation = 'column';
        w.alignChildren = ['fill', 'top'];
        w.add('statictext', undefined, head);
        w.add('statictext', undefined, 'Not transferred 1:1 (' + all.length + '):');
        var t = w.add('edittext', undefined, all.join('\n'), { multiline: true, readonly: true, scrolling: true });
        t.preferredSize = [600, 340];
        w.add('button', undefined, 'OK');
        w.show();
    }

    // tests drive importDoc() directly; normal runs show the file dialog
    $.global.F2A = { importDoc: importDoc };
    if (!$.global.F2A_TEST) main();
})();
