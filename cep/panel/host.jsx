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
    /** AE hands out a new wrapper per access: compare layers by comp + index, never with === */
    function sameLayer(a, b) { return !!a && !!b && a.index === b.index && a.containingComp.id === b.containingComp.id; }
    function ids(c) { var o = {}; for (var i = 1; i <= c.numLayers; i++) o[layerKey(c.layer(i))] = true; return o; }
    function layerKey(L) { return typeof L.id === 'number' ? 'id' + L.id : null; }

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
        var res;
        try { res = precompSel(c, lays); } catch (e) { res = err('Precomp failed: ' + (e && e.message || e)); }
        app.endUndoGroup();
        return res;
    }
    function precompSel(c, lays) {
        {
            var b = boundsOf(c, lays);
            var idx = [];
            for (var i = 0; i < lays.length; i++) idx.push(lays[i].index);
            idx.sort(function (a, z) { return a - z; });
            var top = c.layer(idx[0]);
            var name = lays.length === 1 ? top.name : top.name + ' group';
            var nc = c.layers.precompose(idx, name, true);
            var pl = null;
            for (var j = 1; j <= c.numLayers; j++) { var sj = c.layer(j).source; if (sj && sj.id === nc.id) { pl = c.layer(j); break; } }
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
        }
    }

    /** Un-Precomp: the layers of a selected precomp go back into this comp, where they were */
    /** optsJson: {"trim": true} — the layers keep the in/out of the precomp layer they came from (panel gear) */
    function unprecomp(optsJson) {
        var c = activeComp();
        if (!c) return err('Open a composition first');
        var sel = selected(c), pre = [], trim = false, pick = true, extend = false, made = [];
        try { var uo = optsJson ? eval('(' + optsJson + ')') : {}; trim = !!uo.trim; pick = uo.select !== false; extend = !!uo.extend; } catch (e0) {}
        for (var i = 0; i < sel.length; i++) if (sel[i].source instanceof CompItem) pre.push(sel[i]);
        if (!pre.length) return err('Select a precomp layer');
        var notes = [], moved = 0, res;
        app.beginUndoGroup('Fig2AE: Un-Precomp');
        // no "return" inside catch/finally: ExtendScript then throws "Object of type Error found where…"
        try {
            for (var p = 0; p < pre.length; p++) moved += unprecompOne(c, pre[p], notes, trim, made);
            if (extend) extendPrecomps(c, made, notes);
            if (pick) {                                             // the unpacked layers end up selected (panel gear)
                for (var s = 1; s <= c.numLayers; s++) c.layer(s).selected = false;
                for (var m = 0; m < made.length; m++) try { made[m].selected = true; } catch (eS) {}
            }
            res = ok(moved + ' layer(s) moved out' + (notes.length ? ' · ' + notes.join(' · ') : ''));
        } catch (e) { res = err('Un-Precomp failed: ' + (e && e.message || e)); }
        app.endUndoGroup();
        return res;
    }

    /**
     * AE (26.2, tested) refuses copyToComp of a layer that has a parent or a linked expression
     * while an undo group is open. The parent is taken off for the copy without moving anything
     * (setParentWithJump keeps the local values) and put back right after; when AE still refuses
     * (expressions), the undo group is closed for that one copy.
     */
    function copyLayer(o, c) {
        var par = o.parent, lk = o.locked, n0 = c.numLayers;
        if (lk) o.locked = false;
        try {
            if (par) o.setParentWithJump(null);
            try { o.copyToComp(c); }
            catch (e) {
                if (c.numLayers !== n0) throw e;
                app.endUndoGroup();
                try { o.copyToComp(c); } finally { app.beginUndoGroup('Fig2AE: Un-Precomp'); }
            }
        } finally {
            if (par) o.setParentWithJump(par);
            if (lk) o.locked = true;
        }
    }

    function unprecompOne(c, P, notes, trim, made) {
        var src = P.source, n = src.numLayers, copies = [], i;
        if (!n) { unlocked(P, function () { P.remove(); }); return 0; }
        // bottom first: every copy lands on top, so the stack keeps its order.
        // The copy is found as the layer that was not there before (Layer.id, AE 22+), else layer 1.
        try {
            for (i = n; i >= 1; i--) {
                var before = ids(c), n0 = c.numLayers;
                copyLayer(src.layer(i), c);
                if (c.numLayers !== n0 + 1) throw new Error('After Effects did not copy "' + src.layer(i).name + '"');
                copies[i] = c.layer(1);
                if (layerKey(c.layer(1)) !== null) {
                    for (var q = 1; q <= c.numLayers; q++) if (!before[layerKey(c.layer(q))]) { copies[i] = c.layer(q); break; }
                }
            }
        } catch (e) {
            // half a precomp in the comp is worse than none: take the copies out again
            for (i = 1; i <= n; i++) if (copies[i]) try { copies[i].locked = false; copies[i].remove(); } catch (e2) {}
            throw e;
        }
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
                if (o.hasTrackMatte && o.trackMatteLayer && o.trackMatteLayer.containingComp.id === src.id)
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
        if (trim) trimTo(copies, n, P, notes);
        for (i = 1; i <= n; i++) made.push(copies[i]);
        for (i = 1; i <= n; i++) if (src.layer(i).locked) copies[i].locked = true;
        unlocked(P, function () {
            if (anim) { P.enabled = false; P.audioEnabled = false; P.shy = true; }
            else P.remove();
        });
        return n;
    }

    /**
     * "Trim to precomp length": each layer starts and ends where the precomp layer did (never longer than
     * it was). A layer wholly outside that span showed nothing in the precomp — it is left as it was.
     */
    function trimTo(copies, n, P, notes) {
        var pin = P.inPoint, pout = P.outPoint, outside = 0;
        if (P.stretch !== 100 || P.timeRemapEnabled) notes.push('time stretch / time remap of "' + P.name + '" was not carried over');
        for (var i = 1; i <= n; i++) {
            var L = copies[i], a = Math.max(L.inPoint, pin), b = Math.min(L.outPoint, pout);
            if (b - a <= 0) { outside++; continue; }
            if (L.locked) L.locked = false;
            try { L.inPoint = a; L.outPoint = b; } catch (e) { notes.push('could not trim "' + L.name + '": ' + e); }
        }
        if (outside) notes.push(outside + ' layer(s) of "' + P.name + '" lie outside its time span — left untrimmed');
    }

    /* ------------------------------------------------------------ FONTS */

    // text layers Fig2AE set in a stand-in font (ae/Fig2AE.jsx): "fig2ae:fonts=<start>-<end>:<Family>|<Style>;…"
    var FONT_TAG = 'fig2ae:fonts=';
    function taggedText() {
        var out = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var c = app.project.item(i);
            if (!(c instanceof CompItem)) continue;
            for (var k = 1; k <= c.numLayers; k++) {
                var L = c.layer(k);
                if (L instanceof TextLayer && String(L.comment).indexOf(FONT_TAG) === 0) out.push(L);
            }
        }
        return out;
    }
    function parseTag(s) {
        var parts = String(s).split(/\r\n|\r|\n/)[0].substring(FONT_TAG.length).split(';'), out = [];   // line 1; a Figma link may follow
        for (var i = 0; i < parts.length; i++) {
            var m = /^(\d+)-(\d+):(.*)\|(.*)$/.exec(parts[i]);
            if (m) out.push({ start: +m[1], end: +m[2], family: m[3], style: m[4] });
        }
        return out;
    }

    /** "Re-check missing fonts", step 1: the fonts the tagged text layers are waiting for, one "Family|Style" per line */
    function fontScan() {
        if (!app.project) return err('No project');
        var lays = taggedText(), seen = {}, list = [];
        for (var i = 0; i < lays.length; i++) {
            var t = parseTag(lays[i].comment);
            for (var k = 0; k < t.length; k++) {
                var key = t[k].family + '|' + t[k].style;
                if (!seen[key]) { seen[key] = 1; list.push(key); }
            }
        }
        return ok(lays.length + '\n' + list.join('\n'));
    }

    /**
     * Step 2: mapJson {"Family|Style": "PostScriptName"} (matched in node with ae/fontmatch.jsx) — every
     * tagged range whose font is now installed gets it. The ink edge the paragraph is aligned to stays where
     * it was, so the text does not jump. Fixed ranges leave the tag; the rest stays for the next check.
     */
    function fontApply(mapJson) {
        var map;
        try { map = eval('(' + mapJson + ')'); } catch (e) { return err('bad font map'); }
        var lays = taggedText(), fixed = 0, layersFixed = 0, still = {}, res;
        app.beginUndoGroup('Fig2AE: re-check fonts');
        try {
            for (var i = 0; i < lays.length; i++) {
                var L = lays[i], tag = parseTag(L.comment), keep = [], any = false;
                var prop = L.property('ADBE Text Properties').property('ADBE Text Document'), td = prop.value;
                var r0 = null;
                try { r0 = L.sourceRectAtTime(L.containingComp.time, false); } catch (e0) {}
                for (var k = 0; k < tag.length; k++) {
                    var t = tag[k], ps = map[t.family + '|' + t.style], font = null;
                    if (ps) try { var fl = app.fonts.getFontsByPostScriptName(ps); font = fl && fl.length ? fl[0] : null; } catch (e1) {}
                    if (!font) { keep.push(t); still[t.family + ' ' + t.style] = 1; continue; }
                    var whole = tag.length === 1 || typeof td.characterRange !== 'function';
                    var target = whole ? td : td.characterRange(t.start, Math.min(t.end, td.text.length));
                    try { target.fontObject = font; } catch (e2) { target.font = font.postScriptName; }
                    any = true; fixed++;
                }
                if (!any) continue;
                unlocked(L, function () {
                    prop.setValue(td);
                    keepInk(L, r0);
                    var rest = String(L.comment).split(/\r\n|\r|\n/).slice(1).join('\r');
                    L.comment = (keep.length ? FONT_TAG + (function () { var a = []; for (var q = 0; q < keep.length; q++) a.push(keep[q].start + '-' + keep[q].end + ':' + keep[q].family + '|' + keep[q].style); return a.join(';'); })() : '') + (rest ? (keep.length ? '\r' : '') + rest : '');
                });
                layersFixed++;
            }
            var miss = [];
            for (var s in still) miss.push(s);
            res = ok(layersFixed + ' text layer(s) updated, ' + fixed + ' font run(s) replaced' + (miss.length ? '\n' + miss.join('\n') : ''));
        } catch (e) { res = err('Re-check failed: ' + (e && e.message || e)); }
        app.endUndoGroup();
        return res;
    }

    /** after a font change: move the anchor so the aligned edge (left / centre / right) and the vertical centre stay put */
    function keepInk(L, r0) {
        if (!r0) return;
        var a = L.property('ADBE Transform Group').property('ADBE Anchor Point');
        if (a.numKeys > 0 || a.expressionEnabled) return;
        var r1 = L.sourceRectAtTime(L.containingComp.time, false), td = L.property('ADBE Text Properties').property('ADBE Text Document').value;
        var k = td.justification === ParagraphJustification.CENTER_JUSTIFY ? 0.5 : td.justification === ParagraphJustification.RIGHT_JUSTIFY ? 1 : 0;
        var dx = (r1.left + r1.width * k) - (r0.left + r0.width * k), dy = (r1.top + r1.height / 2) - (r0.top + r0.height / 2);
        var v = a.value;
        a.setValue(v.length > 2 ? [v[0] + dx, v[1] + dy, v[2]] : [v[0] + dx, v[1] + dy]);
    }

    /**
     * "Extend precomps to the end of the comp": every precomp among the unpacked layers runs to the end of this
     * comp — its comp gets longer, and so does every precomp inside it, all the way down. Inside a lengthened comp,
     * a layer that ran to its old end runs to the new end; a layer that ends earlier on purpose keeps its out point.
     */
    function extendPrecomps(c, made, notes) {
        var seen = {}, n = 0;
        for (var i = 0; i < made.length; i++) {
            var L = made[i];
            if (!(L.source instanceof CompItem) || L.timeRemapEnabled || L.stretch !== 100) continue;
            var need = c.duration - L.startTime;
            if (need <= 0) continue;
            lengthen(L.source, need, seen);
            unlocked(L, function () { L.outPoint = c.duration; });
            n++;
        }
        if (n) notes.push(n + ' precomp(s) extended to the end of the comp');
    }
    function lengthen(comp, dur, seen) {
        if (seen[comp.id] && seen[comp.id] >= dur) return;
        seen[comp.id] = dur;
        var old = comp.duration, f = comp.frameDuration || 1 / 30;
        if (old < dur) comp.duration = dur;
        for (var k = 1; k <= comp.numLayers; k++) {
            var L = comp.layer(k);
            if (L.timeRemapEnabled || L.stretch !== 100) continue;
            if (L.source instanceof CompItem) lengthen(L.source, comp.duration - L.startTime, seen);
            if (L.outPoint >= old - f / 2 && L.outPoint < comp.duration) (function (Lk) { unlocked(Lk, function () { Lk.outPoint = comp.duration; }); })(L);
        }
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
                    if (sameLayer(L.parent, N)) (function (L) { unlocked(L, function () { L.parent = N.parent; }); kids++; })(L);
                }
            }
            for (k = 0; k < nulls.length; k++) (function (N) { unlocked(N, function () { N.remove(); }); })(nulls[k]);
        } finally { app.endUndoGroup(); }
        return ok(nulls.length + ' group layer(s) deleted, ' + kids + ' layer(s) kept in place');
    }
    function isGroupNull(L) { return L.nullLayer && String(L.comment).indexOf(GROUP_TAG) === 0; }

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

    return { fontScan: fontScan, fontApply: fontApply, precomp: precomp, unprecomp: unprecomp, toggleGuides: toggleGuides, deleteGroups: deleteGroups,
             saveOpts: saveOpts, pickFolder: pickFolder, openFolder: openFolder, importFile: importFile };
})();
'OK\tloaded';
