/**
 * Fig2AE panel — After Effects side (ExtendScript, ES3).
 * Loaded once by panel/index.html; every call returns a string:
 *   "OK\t<message>" or "ERR\t<message>".
 * The GROUPS tools work on the active composition, like AEUX.
 */
$.global.F2A_HOST = (function () {
    var GROUP_TAG = 'fig2ae:group';

    function ok(m) { return 'OK\t' + m; }
    function err(m) { return 'ERR\t' + m; }

    function activeComp() {
        var a = app.project ? app.project.activeItem : null;
        return (a && a instanceof CompItem) ? a : null;
    }
    function selected(c) {
        var s = c.selectedLayers, out = [];
        for (var i = 0; i < s.length; i++) out.push(s[i]);
        return out;
    }
    function unlocked(lay, fn) {
        var lk = lay.locked;
        if (lk) lay.locked = false;
        try { fn(); } finally { if (lk) lay.locked = true; }
    }
    function animated(p) { return p.numKeys > 0 || (p.canSetExpression && p.expressionEnabled && p.expression !== ''); }

    /** moves an unparented layer by d (keyframes too; separated X/Y too) */
    function shiftLayer(lay, d) {
        var tr = lay.property('ADBE Transform Group');
        var pos = tr.property('ADBE Position');
        function shift(p, dv) {
            if (p.numKeys > 0) {
                for (var k = 1; k <= p.numKeys; k++) {
                    var v = p.keyValue(k);
                    p.setValueAtKey(k, typeof v === 'number' ? v + dv[0] : add(v, dv));
                }
            } else {
                var v0 = p.value;
                p.setValue(typeof v0 === 'number' ? v0 + dv[0] : add(v0, dv));
            }
        }
        function add(v, dv) { var r = v.slice ? v.slice(0) : [v[0], v[1]]; r[0] += dv[0]; r[1] += dv[1]; return r; }
        unlocked(lay, function () {
            if (pos.dimensionsSeparated) {
                shift(tr.property('ADBE Position_0'), [d[0]]);
                shift(tr.property('ADBE Position_1'), [d[1]]);
            } else shift(pos, d);
        });
    }

    /** comp-space bounds of layers: sourceRectAtTime + toComp, evaluated by a temporary expression */
    function boundsOf(c, lays) {
        var tmp = c.layers.addNull();
        tmp.name = '__fig2ae_measure';
        var p = tmp.property('ADBE Effect Parade').addProperty('ADBE Point Control').property(1);
        var b = null;
        try {
            for (var i = 0; i < lays.length; i++) {
                var L = lays[i];
                if (!(L instanceof AVLayer)) continue;            // cameras, lights
                for (var k = 0; k < 4; k++) {
                    p.expression = 'var L = thisComp.layer(' + L.index + '); var r = L.sourceRectAtTime(time, false);' +
                                   'L.toComp([r.left' + (k & 1 ? ' + r.width' : '') + ', r.top' + (k & 2 ? ' + r.height' : '') + '])';
                    var v = p.valueAtTime(c.time, false);
                    if (!b) b = [v[0], v[1], v[0], v[1]];
                    else { b[0] = Math.min(b[0], v[0]); b[1] = Math.min(b[1], v[1]); b[2] = Math.max(b[2], v[0]); b[3] = Math.max(b[3], v[1]); }
                }
            }
        } finally { tmp.remove(); }
        return b;
    }

    /* ------------------------------------------------------------ GROUPS */

    /** Precomp: selected layers -> a precomp cropped to their bounds, everything stays in place */
    function precomp() {
        var c = activeComp();
        if (!c) return err('Open a composition first');
        var lays = selected(c);
        if (!lays.length) return err('Select the layers to precompose');
        app.beginUndoGroup('Fig2AE: Precomp');
        try {
            var b = boundsOf(c, lays);
            var idx = [];
            for (var i = 0; i < lays.length; i++) idx.push(lays[i].index);
            idx.sort(function (a, z) { return a - z; });
            var top = c.layer(idx[0]);
            var name = lays.length === 1 ? top.name : top.name + ' group';
            var nc = c.layers.precompose(idx, name, true);
            var pl = null;
            for (var j = 1; j <= c.numLayers; j++) if (c.layer(j).source === nc) { pl = c.layer(j); break; }
            if (b) {
                var bx = Math.floor(b[0]), by = Math.floor(b[1]);
                var w = Math.max(4, Math.min(30000, Math.ceil(b[2]) - bx)), h = Math.max(4, Math.min(30000, Math.ceil(b[3]) - by));
                for (var n = 1; n <= nc.numLayers; n++) if (!nc.layer(n).parent) shiftLayer(nc.layer(n), [-bx, -by]);
                nc.width = w; nc.height = h;
                if (pl) {
                    pl.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([w / 2, h / 2]);
                    pl.property('ADBE Transform Group').property('ADBE Position').setValue([bx + w / 2, by + h / 2]);
                }
            }
            if (pl) { for (var s = 1; s <= c.numLayers; s++) c.layer(s).selected = false; pl.selected = true; }
            return ok('Precomp "' + nc.name + '" — ' + nc.width + '×' + nc.height);
        } catch (e) { return err('Precomp failed: ' + e); }
        finally { app.endUndoGroup(); }
    }

    /** Un-Precomp: the layers of a selected precomp go back into this comp, where they were */
    function unprecomp() {
        var c = activeComp();
        if (!c) return err('Open a composition first');
        var sel = selected(c), pre = [];
        for (var i = 0; i < sel.length; i++) if (sel[i].source instanceof CompItem) pre.push(sel[i]);
        if (!pre.length) return err('Select a precomp layer');
        var notes = [], moved = 0;
        app.beginUndoGroup('Fig2AE: Un-Precomp');
        try {
            for (var p = 0; p < pre.length; p++) moved += unprecompOne(c, pre[p], notes);
        } catch (e) { return err('Un-Precomp failed: ' + e); }
        finally { app.endUndoGroup(); }
        return ok(moved + ' layer(s) moved out' + (notes.length ? ' · ' + notes.join(' · ') : ''));
    }

    function unprecompOne(c, P, notes) {
        var src = P.source, n = src.numLayers, copies = [], i;
        if (!n) { unlocked(P, function () { P.remove(); }); return 0; }
        // bottom first: every copy lands on top, so the stack keeps its order
        for (i = n; i >= 1; i--) { src.layer(i).copyToComp(c); copies[i] = c.layer(1); }
        for (i = 1; i <= n; i++) {
            var cp = copies[i];
            if (cp.locked) cp.locked = false;
            cp.moveBefore(P);
            if (P.startTime) cp.startTime += P.startTime;
        }
        for (i = 1; i <= n; i++) {
            var o = src.layer(i), cpi = copies[i];
            // parents inside the precomp: same local values, same relation
            if (o.parent) cpi.setParentWithJump(copies[o.parent.index]);
            else cpi.setParentWithJump(P);                       // precomp space -> P's transform
            // track mattes (AE 23+ keeps them by reference)
            try {
                if (o.hasTrackMatte && o.trackMatteLayer && o.trackMatteLayer.containingComp === src)
                    cpi.setTrackMatte(copies[o.trackMatteLayer.index], o.trackMatteType);
            } catch (e) {}
        }
        var tr = P.property('ADBE Transform Group');
        var anim = animated(tr.property('ADBE Anchor Point')) || animated(tr.property('ADBE Position')) ||
                   animated(tr.property('ADBE Scale')) || animated(tr.property('ADBE Rotate Z'));
        if (anim) notes.push('"' + P.name + '" is animated — the precomp layer is kept as their parent (hidden)');
        else for (i = 1; i <= n; i++) if (!src.layer(i).parent) copies[i].parent = P.parent;   // keeps them where they are
        if (tr.property('ADBE Opacity').value < 100 || P.property('ADBE Effect Parade').numProperties || P.blendingMode !== BlendingMode.NORMAL)
            notes.push('opacity / effects / blend mode of "' + P.name + '" were not carried over');
        for (i = 1; i <= n; i++) if (src.layer(i).locked) copies[i].locked = true;
        unlocked(P, function () {
            if (anim) { P.enabled = false; P.audioEnabled = false; P.shy = true; }
            else P.remove();
        });
        return n;
    }

    /** Toggle guide layer visibility (the Figma reference frame is a guide layer) */
    function toggleGuides() {
        var c = activeComp();
        if (!c) return err('Open a composition first');
        var guides = [], anyOn = false, i;
        collect(c, guides, {});
        if (!guides.length) return err('No guide layers in this comp');
        for (i = 0; i < guides.length; i++) if (guides[i].enabled) anyOn = true;
        app.beginUndoGroup('Fig2AE: Toggle guide layers');
        try {
            for (i = 0; i < guides.length; i++) (function (g) { unlocked(g, function () { g.enabled = !anyOn; }); })(guides[i]);
        } finally { app.endUndoGroup(); }
        return ok(guides.length + ' guide layer(s) ' + (anyOn ? 'hidden' : 'shown'));
    }
    function collect(c, out, seen) {
        if (seen[c.id]) return;
        seen[c.id] = true;
        for (var i = 1; i <= c.numLayers; i++) {
            var L = c.layer(i);
            if (L.guideLayer) out.push(L);
            if (L.source instanceof CompItem) collect(L.source, out, seen);
        }
    }

    /** Delete group layers: the group nulls Fig2AE made (selected ones, or all); children stay where they are */
    function deleteGroups() {
        var c = activeComp();
        if (!c) return err('Open a composition first');
        var sel = selected(c), nulls = [], i;
        for (i = 0; i < sel.length; i++) if (isGroupNull(sel[i])) nulls.push(sel[i]);
        if (!nulls.length) for (i = 1; i <= c.numLayers; i++) if (isGroupNull(c.layer(i))) nulls.push(c.layer(i));
        if (!nulls.length) return err('No group layers in this comp');
        app.beginUndoGroup('Fig2AE: Delete group layers');
        var kids = 0;
        try {
            for (var k = 0; k < nulls.length; k++) {
                var N = nulls[k];
                for (i = 1; i <= c.numLayers; i++) {
                    var L = c.layer(i);
                    if (L.parent === N) (function (L) { unlocked(L, function () { L.parent = N.parent; }); kids++; })(L);
                }
            }
            for (k = 0; k < nulls.length; k++) (function (N) { unlocked(N, function () { N.remove(); }); })(nulls[k]);
        } finally { app.endUndoGroup(); }
        return ok(nulls.length + ' group layer(s) deleted, ' + kids + ' layer(s) kept in place');
    }
    function isGroupNull(L) { return L.nullLayer && L.comment === GROUP_TAG; }

    /* ------------------------------------------------------------ SYSTEM */

    function saveOpts(json) {
        try { app.settings.saveSetting('Fig2AE', 'opts', json); return ok('saved'); } catch (e) { return err(String(e)); }
    }

    function pickFolder(start) {
        var f = (start ? new Folder(start) : Folder.myDocuments).selectDlg('Where Fig2AE keeps exports and images');
        return f ? ok(f.fsName) : err('');
    }

    function openFolder(path) {
        var f = new Folder(path);
        if (!f.exists) f.create();
        return f.execute() ? ok('') : err('Cannot open ' + path);
    }

    /** a fig2ae_*.jsx saved by the Figma plugin when AE was not reachable */
    function importFile(optsJson) {
        if (!app.project) app.newProject();
        var f = File.openDialog('Fig2AE export file', '*.jsx');
        if (!f) return err('');
        f.encoding = 'BINARY';
        var tail = '';
        if (f.open('r')) { f.seek(Math.max(0, f.length - 64)); tail = f.read(); f.close(); }
        if (tail.indexOf('F2A-PAYLOAD-END*/') < 0) return err('"' + File.decode(f.name) + '" is an old export format. Export it again.');
        var g = $.global, e0 = '';
        g.F2A_QUIET = true; g.F2A_LAST = null;
        try { g.F2A_OPTS = eval('(' + optsJson + ')'); } catch (e) { g.F2A_OPTS = null; }
        try { $.evalFile(f); } catch (e) { e0 = String(e); }
        g.F2A_QUIET = false; g.F2A_OPTS = null;
        var r = g.F2A_LAST;
        if (!r || !r.comp) return err('Import not finished' + (e0 ? ': ' + e0 : ''));
        var all = r.log.concat(r.figmaWarnings || []);
        return ok('"' + r.comp.name + '" imported in ' + r.secs.toFixed(1) + ' s' + (all.length ? '\n' + all.join('\n') : ''));
    }

    return { precomp: precomp, unprecomp: unprecomp, toggleGuides: toggleGuides, deleteGroups: deleteGroups,
             saveOpts: saveOpts, pickFolder: pickFolder, openFolder: openFolder, importFile: importFile };
})();
'OK\tloaded';
