/**
 * Runs inside After Effects:
 *   AfterFX.exe -r "<project>\test\ae\run.jsx"
 * Runs test/out/scene.jsx (the file the plugin saves), renders frame 0 to
 * test/out/scene_ae.png and dumps facts to test/out/ae_result.txt (toSource).
 * Refuses to run if the open project has anything in it — never touches user work.
 */
(function () {
    var ownProject = false, before = {};
    // a fresh unsaved project, at most holding the empty comp AE auto-creates
    function untouched(p) {
        if (p.file) return false;
        for (var i = 1; i <= p.numItems; i++) { var it = p.item(i); if (!(it instanceof CompItem) || it.numLayers > 0) return false; }
        return true;
    }
    var here = File($.fileName).parent, root = here.parent.parent;
    var out = new Folder(root.fsName + '/test/out');
    var res = { ok: false, version: app.version, errors: [], log: [], layers: [], text: null };

    function finish() {
        var f = new File(out.fsName + '/ae_result.txt');
        f.encoding = 'UTF-8'; f.open('w'); f.write(res.toSource()); f.close();
    }

    try {
        if (app.project && app.project.file && !$.global.F2A_TEST_ANY_PROJECT) throw new Error('в открытом проекте что-то есть — тест не трогает чужую работу');
        if (!app.project) app.newProject();
        ownProject = true;
        for (var q0 = 1; q0 <= app.project.numItems; q0++) before[app.project.item(q0).id] = 1;

        // run the very file the Figma plugin saves, the way a user runs it (minus the final dialog)
        $.global.F2A_QUIET = true;
        $.global.F2A_LAST = null;
        $.evalFile(new File(out.fsName + '/scene.jsx'));
        var r = $.global.F2A_LAST;
        if (!r) throw new Error('scene.jsx не отработал');
        res.log = r.log;
        var c = r.comp;
        if (!c) throw new Error('композиция не создана');

        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i), info = { i: i, name: l.name, kind: l.matchName, matte: false };
            try { info.pos = l.transform.position.value; info.anchor = l.transform.anchorPoint.value; info.rot = l.transform.rotation.value; } catch (e) {}
            try { info.matte = l.hasTrackMatte; info.guide = l.guideLayer; info.enabled = l.enabled; } catch (e) {}
            res.layers.push(info);
            if (l instanceof TextLayer) {
                var td = l.property('ADBE Text Properties').property('ADBE Text Document').value;
                info.font = td.fontObject ? td.fontObject.familyName + ' ' + td.fontObject.styleName : td.font;
                if (l.name !== 'text') continue;
                var rect = l.sourceRectAtTime(0, false);
                var cr = td.characterRange(6, 11), c0 = td.characterRange(0, 5);
                res.text = {
                    rect: [rect.left, rect.top, rect.width, rect.height],
                    anchor: l.transform.anchorPoint.value, pos: l.transform.position.value,
                    styleWorld: cr.fontObject ? cr.fontObject.styleName : cr.font,
                    styleHello: c0.fontObject ? c0.fontObject.styleName : c0.font,
                    colorWorld: cr.fillColor, colorHello: c0.fillColor,
                    leading: td.leading, autoLeading: td.autoLeading, lines: td.composedLineCount
                };
            }
        }

        c.resolutionFactor = [1, 1];
        var png = new File(out.fsName + '/scene_ae.png');
        if (png.exists) png.remove();
        c.saveFrameToPng(0, png);
        for (var w = 0; w < 100 && !png.exists; w++) $.sleep(200);     // may finish asynchronously
        $.sleep(500);
        res.png = png.exists;
        res.ok = true;
    } catch (e) {
        res.errors.push(e.toString() + ' (line ' + e.line + ')');
    }
    finish();
    // never close the project: just remove what this script added
    if (ownProject) {
        for (var q = app.project.numItems; q >= 1; q--) {
            try { if (!before[app.project.item(q).id]) app.project.item(q).remove(); } catch (e) {}
        }
    }
})();
