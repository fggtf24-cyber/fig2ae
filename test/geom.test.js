/* node test/geom.test.js  - the one runnable check for the path/matrix math. */
var assert = require('assert');
var g = require('../ae/geom.jsx');

function near(a, b, eps) { assert.ok(Math.abs(a - b) < (eps || 1e-4), a + ' != ' + b); }
function nearPt(p, q, eps) { near(p[0], q[0], eps); near(p[1], q[1], eps); }

/* 1. closed triangle: 3 vertices, not 4 (the AEUX-style duplicate-seam bug) */
var tri = g.parsePath('M0 0 L10 0 L10 10 Z');
assert.strictEqual(tri.length, 1);
assert.strictEqual(tri[0].v.length, 3);
assert.strictEqual(tri[0].closed, true);

/* 2. explicit duplicate closing point is folded away, its tangent kept */
var dup = g.parsePath('M0 0 C 5 0 10 5 10 10 C 5 10 0 5 0 0 Z');
assert.strictEqual(dup[0].v.length, 2);
nearPt(dup[0].i[0], [0, 5]);           // in-tangent came from the dropped vertex
assert.strictEqual(dup[0].closed, true);

/* 3. multiple subpaths (donut) stay separate */
var donut = g.parsePath('M0 0 L10 0 L10 10 L0 10 Z M3 3 L3 7 L7 7 L7 3 Z');
assert.strictEqual(donut.length, 2);
assert.strictEqual(donut[1].v.length, 4);

/* 4. relative commands + implicit repeats */
var rel = g.parsePath('m10 10 l5 0 5 5z');
nearPt(rel[0].v[1], [15, 10]);
nearPt(rel[0].v[2], [20, 15]);

/* 5. cubic tangents are stored relative to their vertex */
var c = g.parsePath('M0 0 C10 0 20 10 20 20');
nearPt(c[0].o[0], [10, 0]);
nearPt(c[0].i[1], [0, -10]);

/* 6. smooth shorthand reflects the previous control point */
var s = g.parsePath('M0 0 C10 0 10 10 20 10 S30 20 40 20');
nearPt(s[0].o[1], [10, 0]);            // reflection of (10,10) about (20,10)

/* 7. arc flags packed without separators, and the arc lands on its endpoint */
var a = g.parsePath('M0 0a10 10 0 0110 10');
nearPt(a[0].v[a[0].v.length - 1], [10, 10]);
var half = g.parsePath('M0 0 A10 10 0 1 1 0 20');
nearPt(half[0].v[half[0].v.length - 1], [0, 20]);
assert.ok(half[0].v.length >= 3, 'large arc should split into >=2 cubics');

/* 8. quadratics convert to cubics with 2/3 control points */
var q = g.parsePath('M0 0 Q10 0 10 10');
nearPt(q[0].o[0], [20 / 3, 0]);

/* 9. matrix round-trip and decomposition (45deg rotation, 2x scale, offset) */
var r = Math.PI / 4, k = 2;
var m = [k * Math.cos(r), k * Math.sin(r), -k * Math.sin(r), k * Math.cos(r), 30, 40];
var d = g.decompose(m);
near(d.rot, 45); near(d.sx, 2); near(d.sy, 2); near(d.shear, 0);
near(d.tx, 30); near(d.ty, 40);
nearPt(g.apply(g.mul(g.inv(m), m), [7, 9]), [7, 9]);
nearPt(g.apply(m, g.apply(g.inv(m), [123, -45])), [123, -45]);

/* 10. mirrored transform: negative scale, not a bogus 180deg rotation */
var mir = g.decompose([-1, 0, 0, 1, 0, 0]);
near(Math.abs(mir.sx * mir.sy), 1);
assert.ok(mir.sx * mir.sy < 0, 'mirror must keep a negative determinant');

/* 11. exact bezier bounds: a cubic bulge goes beyond its end points but not to its control points */
var bulge = g.parsePath('M0 0 C0 -40 100 -40 100 0');
var bb = g.bounds(bulge);
near(bb.x, 0); near(bb.w, 100);
near(bb.y, -30);                      // max of 3t(1-t)*(-40)*... = -30 at t=.5, control hull would say -40
near(bb.h, 30);
var circ = g.bounds(g.parsePath('M0 10 A10 10 0 1 1 20 10 A10 10 0 1 1 0 10 Z'));
near(circ.x, 0, 1e-3); near(circ.y, 0, 1e-2); near(circ.w, 20, 1e-3); near(circ.h, 20, 1e-2);

/* 12. svd2 reconstructs the matrix: R(rot) * diag(s1,s2) * R(phi) */
function rotM(deg) { var r = deg * Math.PI / 180; return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]; }
[[150, 0, 0, 50], [30, 40, -80, 60], [-2, 1, 3, 0.5], [10, 0, 0, -10]].forEach(function (m) {
  var d = g.svd2(m);
  var back = g.mul(g.mul(rotM(d.rot), [d.s1, 0, 0, d.s2, 0, 0]), rotM(d.phi));
  for (var k = 0; k < 4; k++) near(back[k], m[k], 1e-6);
  assert.ok(d.s1 >= Math.abs(d.s2) - 1e-9, 's1 is the major axis');
});

/* 13. transformSubs: vertices get translation, tangents only the linear part */
var ts = g.transformSubs(g.parsePath('M0 0 C10 0 20 10 20 20'), [2, 0, 0, 3, 5, 7]);
nearPt(ts[0].v[0], [5, 7]);
nearPt(ts[0].o[0], [20, 0]);
nearPt(ts[0].i[1], [0, -30]);

/* 14. gradient preset: valid RIFX tree whatever the stop count, XML carries the stops */
function riffOk(s) {
  function be(o) { return ((s.charCodeAt(o) << 24) | (s.charCodeAt(o + 1) << 16) | (s.charCodeAt(o + 2) << 8) | s.charCodeAt(o + 3)) >>> 0; }
  function walk(off, end) {
    while (off + 8 <= end) {
      var id = s.substr(off, 4), size = be(off + 4);
      if (off + 8 + size > end) return false;
      if ((id === 'RIFX' || id === 'LIST') && !walk(off + 12, off + 8 + size)) return false;
      off += 8 + size + (size & 1);
    }
    return off === end;
  }
  return s.substr(0, 4) === 'RIFX' && walk(0, s.length);
}
[2, 3, 9, 17].forEach(function (n) {
  var stops = [];
  for (var k = 0; k < n; k++) stops.push({ pos: k / (n - 1), color: [k / n, 0.5, 1 - k / n], a: 1 - k / (2 * n) });
  var ffx = g.gradientFfx(stops, 3, 5);
  assert.ok(riffOk(ffx), n + ' stops: broken chunk sizes');
  assert.strictEqual((ffx.match(/<key>Stop-\d+<\/key>/g) || []).length, 2 * n);
  assert.ok(ffx.indexOf("size='32'>" + n + '</int>') > 0);
  assert.strictEqual(ffx.charCodeAt(243), 3, 'group index patched');
  assert.strictEqual(ffx.charCodeAt(387), 5, 'item index patched');
});
// values outside 0..1 (AEUX's fixed-width templates corrupt on these) stay valid
assert.ok(riffOk(g.gradientFfx([{ pos: -0.25, color: [1.5, 0, 0], a: 1 }, { pos: 1.25, color: [0, 0, 1], a: 1 }], 0, 1)));

/* 15. sRGB -> gamma-2.4 encoding: endpoints fixed, mid-grey 0.5 -> 0.5262, darks lifted */
var gm = g.srgbToGamma([0, 0.5, 1], 2.4);
near(gm[0], 0); near(gm[1], 0.5262, 1e-3); near(gm[2], 1);
near(g.srgbToGamma([0.2, 0.2, 0.2], 2.4)[0], 0.2411, 1e-3);

console.log('geom: all checks passed');
