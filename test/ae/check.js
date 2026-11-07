/**
 * node test/ae/check.js            -> verifies test/out/scene_ae.png rendered by run.jsx
 * node test/ae/check.js calibrate  -> prints AE blur units per Gaussian sigma from calibrate.jsx renders
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var vm = require('vm');

var OUT = path.join(__dirname, '..', 'out');

function readPng(file) {
  var b = fs.readFileSync(file), off = 8, idat = [], w, h, depth, type;
  while (off < b.length) {
    var len = b.readUInt32BE(off), t = b.toString('latin1', off + 4, off + 8), d = b.slice(off + 8, off + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; }
    if (t === 'IDAT') idat.push(d);
    off += 12 + len;
  }
  var ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type], bpp = ch * depth / 8, stride = w * bpp;
  var raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(h * stride);
  for (var y = 0; y < h; y++) {
    var f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (var x = 0; x < stride; x++) {
      var a = x >= bpp ? px[dst + x - bpp] : 0, up = y ? px[dst - stride + x] : 0, ul = (y && x >= bpp) ? px[dst - stride + x - bpp] : 0, v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { var p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul); }
      px[dst + x] = v & 255;
    }
  }
  var max = depth === 16 ? 65535 : 255;
  return {
    w: w, h: h,
    get: function (x, y) {   // [r,g,b,a] 0..1, composited over white (scene bg is white anyway)
      x = Math.round(x); y = Math.round(y);
      var o = y * stride + x * bpp, c = [];
      for (var k = 0; k < ch; k++) c.push((depth === 16 ? px.readUInt16BE(o + k * 2) : px[o + k]) / max);
      if (ch === 3) c.push(1);
      return c;
    }
  };
}

if (process.argv[2] === 'calibrate') {
  fs.readdirSync(OUT).filter(function (n) { return /^cal_.*\.png$/.test(n); }).sort(function (a, b) {
    return a.localeCompare(b, 'en', { numeric: true });
  }).forEach(function (name) {
    var kind = name.split('_')[1], v = parseFloat(name.split('_')[2]);
    {
      var img = readPng(path.join(OUT, name));
      var row = [];
      for (var x = 0; x < img.w; x++) row.push(img.get(x, 100)[0]);
      function cross(level) {
        for (var x = 1; x < row.length; x++) if (row[x - 1] >= level && row[x] < level) return x - 1 + (row[x - 1] - level) / (row[x - 1] - row[x]);
        return NaN;
      }
      var sigma = (cross(0.1587) - cross(0.8413)) / 2;
      console.log(kind + ' ' + v + ': sigma = ' + sigma.toFixed(3) + ' px  ->  ' + (v / sigma).toFixed(4) + ' AE units per sigma   (edge at ' + cross(0.5).toFixed(2) + ')');
    }
  });
  process.exit(0);
}

/* ------------------------------------------------------------ scene */

var res = vm.runInNewContext(fs.readFileSync(path.join(OUT, 'ae_result.txt'), 'utf8'));
if (res.errors.length) { console.log('AE ERRORS:', res.errors); process.exit(1); }
console.log('AE', res.version, '| importer log:', res.log.length ? '\n  ' + res.log.join('\n  ') : 'empty');

var img = readPng(path.join(OUT, 'scene_ae.png'));
var fails = 0, n = 0;
function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function expect(name, x, y, rgb, tol) {
  var c = img.get(x, y), d = Math.max(Math.abs(c[0] - rgb[0]), Math.abs(c[1] - rgb[1]), Math.abs(c[2] - rgb[2]));
  n++;
  var ok = d <= (tol || 0.035);
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : '  FAIL') + ' ' + name + ' @' + x + ',' + y + ' got ' + c.slice(0, 3).map(function (v) { return v.toFixed(3); }).join(',') +
              ' want ' + rgb.map(function (v) { return v.toFixed(3); }).join(',') + (ok ? '' : '  (diff ' + d.toFixed(3) + ')'));
}
var R = [1, 0, 0], B = [0, 0, 1], Wt = [1, 1, 1], K = [0, 0, 0];
function gray(v) { return [v, v, v]; }

console.log('linear horizontal');
[25, 100, 175].forEach(function (x) { expect('linH', x, 50, lerp(R, B, (x - 20) / 160)); });

console.log('linear diagonal on non-square shape (AEUX gets the angle wrong here)');
[[100, 130], [40, 150], [170, 110]].forEach(function (p) { expect('linD', p[0], p[1], gray(0.5 * (p[0] - 20) / 160 + 0.5 * (p[1] - 100) / 60)); });

console.log('radial = ellipse on non-square shape (AEUX makes it a circle)');
[[290, 50], [335, 50], [290, 65], [245, 35]].forEach(function (p) {
  var r = Math.sqrt(Math.pow((p[0] - 290) / 90, 2) + Math.pow((p[1] - 50) / 30, 2));
  expect('radial', p[0], p[1], gray(Math.max(0, 1 - r)));
});

console.log('stacked fills, top one multiply');
expect('blend', 230, 130, [0.4, 0.3, 0.2]);

console.log('rotation 30deg');
expect('rot centre', 320, 130, R);
expect('rot along axis', 341.65, 142.5, R);
expect('rot outside', 345, 118, Wt);

console.log('mask -> track matte');
expect('mask inside', 60, 220, R);
expect('mask corner', 25, 185, Wt);
expect('mask right', 105, 220, Wt);

console.log('hard drop shadow, offset (12,12)');
expect('object', 320, 220, B);
expect('shadow', 346, 246, K);
expect('no shadow above', 346, 205, Wt);

console.log('picture: original image + ellipse matte');
expect('avatar centre', 240, 240, [0, 1, 0]);
expect('avatar corner (outside the circle)', 222, 222, Wt);

console.log('blurred picture: Box Blur on the matted precomp, Figma radius 8 -> sigma 4.54');
(function () {
  var sigma = 8 * 1.136364 / 2;
  function phi(z) { var t = 1 / (1 + 0.3275911 * Math.abs(z)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }
  [126, 130, 134, 160].forEach(function (x) {
    var cov = phi((x + 0.5 - 130) / sigma);            // green coverage across the left edge at x = 130
    expect('blurImg r-channel', x, 380, [1 - cov, 1, 1 - cov], 0.06);
  });
})();

console.log('angular gradient (fan under matte): just below 3 o\'clock ~ red, just above ~ blue');
expect('conic t~0.04', 350, 325, lerp(R, B, Math.atan2(5, 20) / (2 * Math.PI)), 0.06);
expect('conic t~0.96', 350, 315, lerp(R, B, 1 - Math.atan2(5, 20) / (2 * Math.PI)), 0.06);
expect('conic t~0.25 (below centre)', 330, 345, lerp(R, B, 0.25), 0.06);

console.log('inner shadow (hard, offset 0,8): black band at the top inside, yellow below');
expect('inner shadow band', 260, 293, K);
expect('inner fill', 260, 330, [1, 1, 0]);
expect('outside stays white', 260, 287, Wt);

console.log('diamond gradient: |dx|/40 + |dy|/20 contours');
[[60, 380, 0], [80, 380, 0.5], [60, 390, 0.5], [70, 385, 0.5]].forEach(function (p) {
  var g = Math.abs(p[0] - 60) / 40 + Math.abs(p[1] - 380) / 20;
  expect('diamond', p[0], p[1], gray(1 - Math.min(1, g)));
});

console.log('text: left-aligned paragraph -> ink left edge at the Figma one (122), vertical centre at 205');
var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, red = 0;
// text is black + red; stop above the green raster square (y >= 220)
for (var y = 182; y < 219; y++) for (var x = 110; x < 300; x++) {
  var c = img.get(x, y);
  if (c[1] < 0.6 && c[2] < 0.6) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (c[0] > 0.7 && c[1] < 0.3 && c[2] < 0.3) red++;
}
var cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
n++;
var tok = Math.abs(x0 - 122) <= 1.5 && Math.abs(cy - 205) <= 1.5;
if (!tok) fails++;
console.log((tok ? '  ok  ' : '  FAIL') + ' ink left ' + x0 + ', centre ' + cx.toFixed(1) + ',' + cy.toFixed(1) + ' (box ' + x0 + '..' + x1 + ' x ' + y0 + '..' + y1 + '), sourceRect ' + JSON.stringify(res.text && res.text.rect));
n++;
var sok = res.text && /bold/i.test(res.text.styleWorld) && !/bold/i.test(res.text.styleHello) && red > 30 &&
          Math.abs(res.text.colorWorld[0] - 1) < 1e-3 && res.text.colorHello[0] < 1e-3;
if (!sok) fails++;
console.log((sok ? '  ok  ' : '  FAIL') + ' per-character styles: "Hello"=' + (res.text && res.text.styleHello) + ', "World"=' + (res.text && res.text.styleWorld) + ', red px=' + red);

console.log('gradient text: live text matting a real gradient (red on the left, blue on the right)');
var gx0 = 1e9, gx1 = -1, inkPx = [];
for (var gy = 296; gy < 350; gy++) for (var gxx = 15; gxx < 225; gxx++) {   // stop before the inner-shadow square
  var gc = img.get(gxx, gy);
  if (gc[0] + gc[1] + gc[2] < 2.4) { inkPx.push([gxx, gc]); gx0 = Math.min(gx0, gxx); gx1 = Math.max(gx1, gxx); }
}
function avgCol(lo, hi) {
  var s = [0, 0, 0], k = 0;
  inkPx.forEach(function (p) { if (p[0] >= lo && p[0] <= hi && p[1][0] + p[1][1] + p[1][2] < 1.2) { s[0] += p[1][0]; s[1] += p[1][1]; s[2] += p[1][2]; k++; } });
  return k ? s.map(function (v) { return v / k; }) : [NaN, NaN, NaN];
}
var span = gx1 - gx0, left = avgCol(gx0, gx0 + span * 0.15), right = avgCol(gx1 - span * 0.15, gx1);
n++;
var gok = inkPx.length > 200 && left[0] > 0.7 && left[2] < 0.3 && right[2] > 0.7 && right[0] < 0.3;
if (!gok) fails++;
console.log((gok ? '  ok  ' : '  FAIL') + ' ink px ' + inkPx.length + ', left ' + left.map(function (v) { return v.toFixed(2); }) +
            ', right ' + right.map(function (v) { return v.toFixed(2); }));

console.log('alpha fade (Linear Wipe) vs Figma linear fade');
[60, 100, 140].forEach(function (x) { var a = (x + 0.5 - 20) / 160; expect('fade', x, 445, gray(1 - a), 0.05); });

console.log('3 stops via shape gradient vs Figma');
(function () {
  var D = [0.2, 0.2, 0.2], Lm = [0.87, 0.99, 0];
  var worst = 0, at = 0, line = [];
  for (var x = 205; x <= 355; x += 15) {
    var t = (x + 0.5 - 200) / 160, want = t < 0.404 ? lerp(D, Lm, t / 0.404) : lerp(Lm, D, (t - 0.404) / 0.596);
    var c = img.get(x, 445), d = Math.max(Math.abs(c[0] - want[0]), Math.abs(c[1] - want[1]), Math.abs(c[2] - want[2]));
    if (d > worst) { worst = d; at = x; }
    line.push(x + ':' + d.toFixed(2));
  }
  n++;
  var ok = worst <= 0.03;
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : '  FAIL') + ' max deviation ' + worst.toFixed(3) + ' at x=' + at + '  [' + line.join(' ') + ']');
  expect('tri lime stop', 265, 445, Lm, 0.08);
})();

console.log('rounded clipping frame: child clipped by the r=20 outline, 4 px outside border kept');
expect('card content', 60, 530, [0, 1, 0]);
expect('card content near the corner arc', 28, 498, [0, 1, 0]);
expect('card corner (outside the arc and the border)', 22, 492, Wt);
expect('card outside border', 18, 530, B);

console.log('shear x\' = x + 0.5 y (Transform effect)');
expect('skew top-left', 155, 502, R);
expect('skew bottom-left is empty', 155, 538, Wt);
expect('skew bottom-right', 205, 538, R);
expect('skew top-right is empty', 205, 502, Wt);

console.log('flipped layer, shadow offset (12,0) on the page');
expect('flipShadow object', 255, 515, B);
expect('flipShadow shadow on the right', 276, 515, K);
expect('flipShadow nothing on the left', 236, 515, Wt);

console.log('rotated shape layer, shadow down on the page');
expect('rotShadow object', 60, 620, B);
expect('rotShadow shadow below', 60, 641, K);
expect('rotShadow nothing on the left', 44, 620, Wt);

console.log('shear then rotation 30deg (comp-space skew along the rotated axis)');
(function () {
  var m = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), Math.cos(Math.PI / 6) * 0.5 - Math.sin(Math.PI / 6), Math.sin(Math.PI / 6) * 0.5 + Math.cos(Math.PI / 6), 160, 580];
  function at(x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  [[20, 20], [5, 35], [35, 5]].forEach(function (q) { var p = at(q[0], q[1]); expect('skewRot inside ' + q, p[0], p[1], R); });
  [[-6, 20], [46, 20], [20, -6], [20, 46]].forEach(function (q) { var p = at(q[0], q[1]); expect('skewRot outside ' + q, p[0], p[1], Wt); });
})();

console.log('flipped clipping frame (precomp), shadow right on the page');
expect('flipFrame object', 285, 615, B);
expect('flipFrame shadow on the right', 306, 615, K);
expect('flipFrame nothing on the left', 264, 615, Wt);

console.log('shadow spread 6 (vector layer + Offset Paths)');
expect('spread object', 315, 515, B);
expect('spread ring left', 297, 515, K);
expect('spread ring below', 315, 533, K);
expect('spread ends at 6 px', 292, 515, Wt);

console.log('underline = Figma bar as a shape; broken node = Figma pixels');
expect('underline bar', 140, 568, K);
expect('below the bar', 140, 572, Wt);
expect('broken -> PNG', 350, 560, [1, 0, 1]);

console.log('rasterize mark and reference frame');
expect('marked layer = Figma pixels (cyan), not the red vector', 350, 610, [0, 1, 1]);
var refL = res.layers.filter(function (l) { return /^Figma reference/.test(l.name); })[0];
n++; var rok = refL && refL.guide === true && refL.enabled === false && refL.i === 1; if (!rok) fails++;
console.log((rok ? '  ok  ' : '  FAIL') + ' reference: top, guide, hidden ' + JSON.stringify(refL));

console.log('"Current": frame centred in a comp 100 x 60 bigger, text moves with the shapes');
(function () {
  var cur = res.current || {}, first = {};
  res.layers.forEach(function (l) { first[l.name] = l.pos; });
  ['linH', 'text'].forEach(function (name) {
    var p = cur[name], q = first[name];
    var ok = cur.mode === 'current' && p && q && Math.abs(p[0] - q[0] - 50) < 0.01 && Math.abs(p[1] - q[1] - 30) < 0.01;
    n++; if (!ok) fails++;
    console.log((ok ? '  ok  ' : '  FAIL') + ' ' + name + ' ' + JSON.stringify(q) + ' -> ' + JSON.stringify(p));
  });
})();

console.log('robustness: no layer failed, tiny comp, icon font');
var bad = res.log.filter(function (t) { return /Error|ERROR|rejected/.test(t); });
n++; if (bad.length) fails++;
console.log((bad.length ? '  FAIL' : '  ok  ') + ' importer errors: ' + (bad.length ? bad.join(' | ') : 'none'));
expect('3x3 frame drawn (comp clamped to 4 px)', 386, 6, R);
var ic = res.layers.filter(function (l) { return l.name === 'icon'; })[0];
n++; var iok = ic && ic.kind === 'ADBE Vector Layer'; if (!iok) fails++;
console.log((iok ? '  ok  ' : '  FAIL') + ' missing icon font -> outline shape layer (' + (ic && ic.kind) + ')');
expect('icon outline', 380, 438, K);

console.log('missing font -> live text in a default font');
var fb = res.layers.filter(function (l) { return l.name === 'fallback'; })[0];
n++;
var fok = fb && /arial|segoe|helvetica|tahoma/i.test(fb.font || '') &&
          res.log.some(function (t) { return /NoSuchFont Sans Medium/.test(t); });
if (!fok) fails++;
console.log((fok ? '  ok  ' : '  FAIL') + ' fallback layer font: ' + (fb && fb.font));

console.log('\n' + (n - fails) + '/' + n + ' checks passed');
process.exit(fails ? 1 : 0);
