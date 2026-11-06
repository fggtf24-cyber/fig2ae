/**
 * Runs inside After Effects:  AfterFX.exe -r "<project>\test\ae\calibrate.jsx"
 * Renders a hard white edge at x=200 blurred by Gaussian Blur and by Drop
 * Shadow softness; test/ae/check.js reads the edge profiles and prints how many
 * AE units correspond to one Gaussian sigma.
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
    var res = { ok: false, errors: [], files: [] };
    try {
        if (app.project && app.project.file && !$.global.F2A_TEST_ANY_PROJECT) throw new Error('в открытом проекте что-то есть — калибровка не трогает чужую работу');
        if (!app.project) app.newProject();
        ownProject = true;
        for (var q0 = 1; q0 <= app.project.numItems; q0++) before[app.project.item(q0).id] = 1;

        var cases = [['blur', 20], ['blur', 60], ['box', 5], ['box', 15], ['box', 40], ['soft', 5], ['soft', 10], ['soft', 20], ['soft', 40], ['soft', 60], ['soft', 100]];
        for (var k = 0; k < cases.length; k++) {
            var kind = cases[k][0], v = cases[k][1];
            var c = app.project.items.addComp('cal_' + kind + v, 400, 200, 1, 1, 25);
            c.layers.addSolid([0, 0, 0], 'bg', 400, 200, 1);
            var s = c.layers.addShape();
            var g = s.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group').property('ADBE Vectors Group');
            var rect = g.addProperty('ADBE Vector Shape - Rect');
            rect.property('ADBE Vector Rect Size').setValue([1000, 1000]);
            rect.property('ADBE Vector Rect Position').setValue([-300, 100]);   // right edge at x = 200 (layer space)
            g.addProperty('ADBE Vector Graphic - Fill').property('ADBE Vector Fill Color').setValue([1, 1, 1]);
            s.transform.anchorPoint.setValue([0, 0]);
            s.transform.position.setValue([0, 0]);
            var fx = s.property('ADBE Effect Parade');
            if (kind === 'box') {
                var bx = fx.addProperty('ADBE Box Blur2');
                bx.property(1).setValue(v);
                bx.property(2).setValue(3);
                bx.property(4).setValue(0);
            } else if (kind === 'blur') {
                var b = fx.addProperty('ADBE Gaussian Blur 2');
                b.property(1).setValue(v);
                b.property(3).setValue(0);
            } else {
                var d = fx.addProperty('ADBE Drop Shadow');
                d.property(1).setValue([1, 1, 1]);
                d.property(2).setValue(255);
                d.property(4).setValue(0);
                d.property(5).setValue(v);
                d.property(6).setValue(1);                                   // shadow only
            }
            var png = new File(out.fsName + '/cal_' + kind + '_' + v + '.png');
            if (png.exists) png.remove();
            c.resolutionFactor = [1, 1];
            c.saveFrameToPng(0, png);
            for (var w = 0; w < 100 && !png.exists; w++) $.sleep(200);
            $.sleep(300);
            res.files.push(png.name);
        }
        res.ok = true;
    } catch (e) {
        res.errors.push(e.toString() + ' (line ' + e.line + ')');
    }
    var f = new File(out.fsName + '/cal_result.txt');
    f.encoding = 'UTF-8'; f.open('w'); f.write(res.toSource()); f.close();
    // never close the project: just remove what this script added
    if (ownProject) {
        for (var q = app.project.numItems; q >= 1; q--) {
            try { if (!before[app.project.item(q).id]) app.project.item(q).remove(); } catch (e) {}
        }
    }
})();
