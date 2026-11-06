/**
 * node test/figma.test.js
 * Fake Figma scene -> figma-plugin/code.js -> JSON. Asserts the export and
 * writes test/out/scene.json, which test/ae/run.jsx then builds in real After
 * Effects and test/ae/check.js verifies pixel by pixel.
 */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');
var build = require('../build.js');
function near(a, b, eps) { assert.ok(Math.abs(a - b) < (eps || 1e-3), a + ' != ' + b); }

/* ------------------------------------------------------- tiny PNG writer */
var CRC = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { var c = 0xffffffff; for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  var td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(w, h, rgba) {
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  var raw = Buffer.alloc(h * (1 + w * 4));
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) for (var k = 0; k < 4; k++) raw[y * (1 + w * 4) + 1 + x * 4 + k] = rgba[k];
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/* ---------------------------------------------------- fake Figma nodes */

var MIXED = { mixed: true };
var FX = 1000, FY = 500;                       // frame position on the page
function solid(r, g, b, extra) { var p = { type: 'SOLID', color: { r: r, g: g, b: b }, opacity: 1, visible: true, blendMode: 'NORMAL' }; for (var k in extra || {}) p[k] = extra[k]; return p; }
function rectPath(w, h) { return 'M0 0L' + w + ' 0L' + w + ' ' + h + 'L0 ' + h + 'Z'; }
function ellipsePath(w, h) { var rx = w / 2, ry = h / 2; return 'M0 ' + ry + 'A' + rx + ' ' + ry + ' 0 1 1 ' + w + ' ' + ry + 'A' + rx + ' ' + ry + ' 0 1 1 0 ' + ry + 'Z'; }

var pageChildren = [];
function node(props) {
  var n = {
    visible: true, locked: false, opacity: 1, blendMode: 'NORMAL', effects: [], strokes: [], fills: [],
    strokeWeight: 1, strokeAlign: 'CENTER', strokeCap: 'NONE', strokeJoin: 'MITER', strokeMiterLimit: 4, dashPattern: [],
    isMask: false, fillGeometry: [], strokeGeometry: []
  };
  for (var k in props) n[k] = props[k];
  if (!n.absoluteTransform) n.absoluteTransform = [[1, 0, FX + n.x], [0, 1, FY + n.y]];
  var t = n.absoluteTransform;
  // axis-aligned bounds of the transformed box
  var pts = [[0, 0], [n.width, 0], [0, n.height], [n.width, n.height]].map(function (p) {
    return [t[0][0] * p[0] + t[0][1] * p[1] + t[0][2], t[1][0] * p[0] + t[1][1] * p[1] + t[1][2]];
  });
  var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
  n.absoluteBoundingBox = { x: Math.min.apply(0, xs), y: Math.min.apply(0, ys), width: Math.max.apply(0, xs) - Math.min.apply(0, xs), height: Math.max.apply(0, ys) - Math.min.apply(0, ys) };
  if (!n.absoluteRenderBounds) n.absoluteRenderBounds = n.absoluteBoundingBox;
  n.clone = function () {
    var c = Object.assign({}, n);
    c.remove = function () { var i = pageChildren.indexOf(c); if (i >= 0) pageChildren.splice(i, 1); };
    Object.defineProperty(c, 'relativeTransform', { set: function (v) { c.absoluteTransform = v; }, get: function () { return c.absoluteTransform; } });
    return c;
  };
  return n;
}

// A: horizontal linear gradient red -> blue
var linH = node({ type: 'RECTANGLE', name: 'linH', x: 20, y: 20, width: 160, height: 60,
  fills: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }],
  fillGeometry: [{ data: rectPath(160, 60), windingRule: 'NONZERO' }] });

// B: diagonal linear gradient (in normalized space) on a non-square rect: g = .5*x/w + .5*y/h
var linD = node({ type: 'RECTANGLE', name: 'linD', x: 20, y: 100, width: 160, height: 60,
  fills: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[0.5, 0.5, 0], [-0.5, 0.5, 0.5]],
    gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }],
  fillGeometry: [{ data: rectPath(160, 60), windingRule: 'NONZERO' }] });

// C: default radial on a non-square rect = ellipse 180x60
var radial = node({ type: 'RECTANGLE', name: 'radial', x: 200, y: 20, width: 180, height: 60,
  fills: [{ type: 'GRADIENT_RADIAL', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] }],
  fillGeometry: [{ data: rectPath(180, 60), windingRule: 'NONZERO' }] });

// D: stacked fills, top one MULTIPLY
var blend = node({ type: 'RECTANGLE', name: 'blend', x: 200, y: 100, width: 60, height: 60,
  fills: [solid(0.8, 0.6, 0.4), solid(0.5, 0.5, 0.5, { blendMode: 'MULTIPLY' })],
  fillGeometry: [{ data: rectPath(60, 60), windingRule: 'NONZERO' }] });

// E: rotated 30deg clockwise, centre (320,130), live centred stroke
var a30 = Math.PI / 6, co = Math.cos(a30), si = Math.sin(a30);
var ox = 320 - (30 * co - 15 * si), oy = 130 - (30 * si + 15 * co);
var rot = node({ type: 'RECTANGLE', name: 'rot', x: 0, y: 0, width: 60, height: 30,
  absoluteTransform: [[co, -si, FX + ox], [si, co, FY + oy]],
  fills: [solid(1, 0, 0)], strokes: [solid(0, 0, 0)], strokeWeight: 4,
  fillGeometry: [{ data: rectPath(60, 30), windingRule: 'NONZERO' }] });

// F: ellipse mask over an overflowing red rect
var mask = node({ type: 'ELLIPSE', name: 'mask', x: 20, y: 180, width: 80, height: 80, isMask: true, maskType: 'ALPHA',
  fills: [solid(0, 1, 0)], fillGeometry: [{ data: ellipsePath(80, 80), windingRule: 'NONZERO' }] });
var masked = node({ type: 'RECTANGLE', name: 'masked', x: 0, y: 170, width: 120, height: 110,
  fills: [solid(1, 0, 0)], fillGeometry: [{ data: rectPath(120, 110), windingRule: 'NONZERO' }] });
var maskGroup = node({ type: 'GROUP', name: 'maskGroup', x: 0, y: 170, width: 120, height: 110, children: [mask, masked] });

// G: two-style text, Arial; fake glyph outline = ink box (2,6)-(150,24) in node space
var text = node({ type: 'TEXT', name: 'text', x: 120, y: 190, width: 160, height: 30,
  characters: 'Hello World', textAutoResize: 'WIDTH_AND_HEIGHT', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP',
  paragraphSpacing: 0, paragraphIndent: 0, textTruncation: 'DISABLED',
  fills: [solid(0, 0, 0)],
  fillGeometry: [{ data: 'M2 6L150 6L150 24L2 24Z', windingRule: 'NONZERO' }],
  getStyledTextSegments: function () {
    var base = { letterSpacing: { unit: 'PIXELS', value: -0.08 }, lineHeight: { unit: 'AUTO' }, textCase: 'ORIGINAL', textDecoration: 'NONE', listOptions: { type: 'NONE' }, fontSize: 24 };
    return [
      Object.assign({ characters: 'Hello ', start: 0, end: 6, fontName: { family: 'Arial', style: 'Regular' }, fills: [solid(0, 0, 0)] }, base),
      Object.assign({ characters: 'World', start: 6, end: 11, fontName: { family: 'Arial', style: 'Bold' }, fills: [solid(1, 0, 0)] }, base)
    ];
  } });

// G2: font that is not installed anywhere -> AE must substitute a default font, keep it live text
var fallback = node({ type: 'TEXT', name: 'fallback', x: 130, y: 262, width: 80, height: 20,
  characters: 'Medium', textAutoResize: 'WIDTH_AND_HEIGHT', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP',
  paragraphSpacing: 0, paragraphIndent: 0, textTruncation: 'DISABLED', fills: [solid(0, 0, 0)],
  fillGeometry: [{ data: 'M1 4L70 4L70 16L1 16Z', windingRule: 'NONZERO' }],
  getStyledTextSegments: function () {
    return [{ characters: 'Medium', start: 0, end: 6, fontName: { family: 'NoSuchFont Sans', style: 'Medium' }, fontSize: 16,
      fills: [solid(0, 0, 0)], letterSpacing: { unit: 'PIXELS', value: 0 }, lineHeight: { unit: 'PIXELS', value: 20 },
      textCase: 'ORIGINAL', textDecoration: 'NONE', listOptions: { type: 'NONE' } }];
  } });

// G3: gradient text (red -> blue across the text box) stays live text as a matte
var gradPaint = { type: 'GRADIENT_LINEAR', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
  gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] };
var gradText = node({ type: 'TEXT', name: 'gradText', x: 20, y: 300, width: 200, height: 40,
  characters: 'GRADIENT', textAutoResize: 'WIDTH_AND_HEIGHT', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP',
  paragraphSpacing: 0, paragraphIndent: 0, textTruncation: 'DISABLED', fills: [gradPaint],
  fillGeometry: [{ data: 'M2 8L196 8L196 32L2 32Z', windingRule: 'NONZERO' }],
  getStyledTextSegments: function () {
    return [{ characters: 'GRADIENT', start: 0, end: 8, fontName: { family: 'Arial', style: 'Bold' }, fontSize: 32,
      fills: [gradPaint], letterSpacing: { unit: 'PIXELS', value: 0 }, lineHeight: { unit: 'PIXELS', value: 40 },
      textCase: 'ORIGINAL', textDecoration: 'NONE', listOptions: { type: 'NONE' } }];
  } });

// H: hard drop shadow (radius 0) offset (12,12)
var shadow = node({ type: 'RECTANGLE', name: 'shadow', x: 300, y: 200, width: 40, height: 40,
  fills: [solid(0, 0, 1)], fillGeometry: [{ data: rectPath(40, 40), windingRule: 'NONZERO' }],
  effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 12, y: 12 }, radius: 0, spread: 0, blendMode: 'NORMAL' }] });

// I: round avatar with an image fill -> ORIGINAL picture + ellipse matte (fake image: green 80x80)
var avatar = node({ type: 'ELLIPSE', name: 'avatar', x: 220, y: 220, width: 40, height: 40,
  fills: [{ type: 'IMAGE', visible: true, opacity: 1, blendMode: 'NORMAL', imageHash: 'h-green', scaleMode: 'FILL', filters: {} }],
  fillGeometry: [{ data: ellipsePath(40, 40), windingRule: 'NONZERO' }] });

// I2: picture with a layer blur -> original picture + matte in a precomp with Box Blur
var blurImg = node({ type: 'RECTANGLE', name: 'blurImg', x: 130, y: 360, width: 60, height: 40,
  fills: [{ type: 'IMAGE', visible: true, opacity: 1, blendMode: 'NORMAL', imageHash: 'h-green', scaleMode: 'FILL', filters: {} }],
  fillGeometry: [{ data: rectPath(60, 40), windingRule: 'NONZERO' }],
  absoluteRenderBounds: { x: FX + 130 - 24, y: FY + 360 - 24, width: 108, height: 88 },
  effects: [{ type: 'LAYER_BLUR', visible: true, radius: 8, blurType: 'NORMAL' }] });

// J: angular gradient red -> blue, fan of wedges under a matte
var conic = node({ type: 'RECTANGLE', name: 'conic', x: 300, y: 290, width: 60, height: 60,
  fills: [{ type: 'GRADIENT_ANGULAR', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }],
  fillGeometry: [{ data: rectPath(60, 60), windingRule: 'NONZERO' }] });

// K: hard inner shadow, offset (0,8), on a yellow square
var inner = node({ type: 'RECTANGLE', name: 'inner', x: 230, y: 290, width: 60, height: 60,
  fills: [solid(1, 1, 0)], fillGeometry: [{ data: rectPath(60, 60), windingRule: 'NONZERO' }],
  effects: [{ type: 'INNER_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 8 }, radius: 0, spread: 0, blendMode: 'NORMAL' }] });

// M: fade like the user's titles: black alpha 0 -> 1, left to right (Linear Wipe)
var fade = node({ type: 'RECTANGLE', name: 'fade', x: 20, y: 425, width: 160, height: 40,
  fills: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 0 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] }],
  fillGeometry: [{ data: rectPath(160, 40), windingRule: 'NONZERO' }] });

// N: three stops white -> lime (.404) -> white (4-Color Gradient, approximate)
var tri = node({ type: 'RECTANGLE', name: 'tri', x: 200, y: 425, width: 160, height: 40,
  fills: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }, { position: 0.404, color: { r: 0.87, g: 0.99, b: 0, a: 1 } }, { position: 1, color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }] }],
  fillGeometry: [{ data: rectPath(160, 40), windingRule: 'NONZERO' }] });

// O: 3x3 clipping frame (AE refuses comps under 4 px)
var tinyDot = node({ type: 'RECTANGLE', name: 'tinyDot', x: 385, y: 5, width: 3, height: 3,
  fills: [solid(1, 0, 0)], fillGeometry: [{ data: rectPath(3, 3), windingRule: 'NONZERO' }] });
var tiny = node({ type: 'FRAME', name: 'tiny', x: 385, y: 5, width: 3, height: 3, clipsContent: true,
  fills: [], fillGeometry: [{ data: rectPath(3, 3), windingRule: 'NONZERO' }], children: [tinyDot] });

// P: icon font that is not installed -> Figma's glyph outline (fake: 12x12 square)
var icon = node({ type: 'TEXT', name: 'icon', x: 372, y: 430, width: 16, height: 16,
  characters: 'star', textAutoResize: 'WIDTH_AND_HEIGHT', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP',
  paragraphSpacing: 0, paragraphIndent: 0, textTruncation: 'DISABLED', fills: [solid(0, 0, 0)],
  fillGeometry: [{ data: 'M2 2L14 2L14 14L2 14Z', windingRule: 'NONZERO' }],
  getStyledTextSegments: function () {
    return [{ characters: 'star', start: 0, end: 4, fontName: { family: 'Material Icons', style: 'Regular' }, fontSize: 16,
      fills: [solid(0, 0, 0)], letterSpacing: { unit: 'PERCENT', value: 0 }, lineHeight: { unit: 'PIXELS', value: 16 },
      textCase: 'ORIGINAL', textDecoration: 'NONE', listOptions: { type: 'NONE' } }];
  } });

// L: diamond gradient white -> black on a non-square rect
var diamond = node({ type: 'RECTANGLE', name: 'diamond', x: 20, y: 360, width: 80, height: 40,
  fills: [{ type: 'GRADIENT_DIAMOND', visible: true, opacity: 1, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] }],
  fillGeometry: [{ data: rectPath(80, 40), windingRule: 'NONZERO' }] });

// Q: card = rounded clipping frame (r 20) with a full-bleed child and a 4 px OUTSIDE border:
// the child must be clipped by the rounded outline, the border must not be cut by the precomp
function rrect(x, y, w, h, r) {
  return 'M' + (x + r) + ' ' + y + 'L' + (x + w - r) + ' ' + y + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w) + ' ' + (y + r) +
         'L' + (x + w) + ' ' + (y + h - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w - r) + ' ' + (y + h) +
         'L' + (x + r) + ' ' + (y + h) + 'A' + r + ' ' + r + ' 0 0 1 ' + x + ' ' + (y + h - r) +
         'L' + x + ' ' + (y + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + r) + ' ' + y + 'Z';
}
var cardImg = node({ type: 'RECTANGLE', name: 'cardImg', x: 20, y: 490, width: 80, height: 80,
  fills: [solid(0, 1, 0)], fillGeometry: [{ data: rectPath(80, 80), windingRule: 'NONZERO' }] });
var card = node({ type: 'FRAME', name: 'card', x: 20, y: 490, width: 80, height: 80, clipsContent: true, cornerRadius: 20,
  fills: [solid(1, 1, 0)], fillGeometry: [{ data: rrect(0, 0, 80, 80, 20), windingRule: 'NONZERO' }],
  strokes: [solid(0, 0, 1)], strokeWeight: 4, strokeAlign: 'OUTSIDE',
  strokeGeometry: [{ data: rrect(-4, -4, 88, 88, 24) + rrect(0, 0, 80, 80, 20), windingRule: 'EVENODD' }],
  children: [cardImg] });

// R: sheared rect x' = x + 0.5 y (AE layers have no shear: Transform effect)
var skew = node({ type: 'RECTANGLE', name: 'skew', x: 0, y: 0, width: 40, height: 40,
  absoluteTransform: [[1, 0.5, FX + 150], [0, 1, FY + 500]],
  fills: [solid(1, 0, 0)], fillGeometry: [{ data: rectPath(40, 40), windingRule: 'NONZERO' }] });

// S: horizontally flipped rect, hard shadow to the RIGHT (page space)
var flipShadow = node({ type: 'RECTANGLE', name: 'flipShadow', x: 0, y: 0, width: 30, height: 30,
  absoluteTransform: [[-1, 0, FX + 270], [0, 1, FY + 500]],
  fills: [solid(0, 0, 1)], fillGeometry: [{ data: rectPath(30, 30), windingRule: 'NONZERO' }],
  effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 12, y: 0 }, radius: 0, spread: 0, blendMode: 'NORMAL' }] });

// T: hard shadow with spread 6, no offset: a 6 px black ring
var spread = node({ type: 'RECTANGLE', name: 'spread', x: 300, y: 500, width: 30, height: 30,
  fills: [solid(0, 0, 1)], fillGeometry: [{ data: rectPath(30, 30), windingRule: 'NONZERO' }],
  effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 0 }, radius: 0, spread: 6, blendMode: 'NORMAL' }] });

// U: underlined text: Figma's outline = glyph box + underline bar; a clone without decoration loses the bar
var GLYPHS = 'M2 2L40 2L40 14L2 14Z', BAR = 'M2 17L40 17L40 19L2 19Z';
function textSeg(chars, extra) {
  var s = { characters: chars, start: 0, end: chars.length, fontName: { family: 'Arial', style: 'Regular' }, fontSize: 16,
    fills: [solid(0, 0, 0)], letterSpacing: { unit: 'PIXELS', value: 0 }, lineHeight: { unit: 'PIXELS', value: 20 },
    textCase: 'ORIGINAL', textDecoration: 'NONE', listOptions: { type: 'NONE' } };
  for (var k in extra || {}) s[k] = extra[k];
  return s;
}
var underline = node({ type: 'TEXT', name: 'underline', x: 120, y: 550, width: 44, height: 20,
  characters: 'Line', textAutoResize: 'WIDTH_AND_HEIGHT', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP',
  paragraphSpacing: 0, paragraphIndent: 0, textTruncation: 'DISABLED', fills: [solid(0, 0, 0)],
  fillGeometry: [{ data: GLYPHS + BAR, windingRule: 'NONZERO' }],
  getStyledTextSegments: function () { return [textSeg(this.characters, { textDecoration: this.fillGeometry[0].data === GLYPHS ? 'NONE' : 'UNDERLINE' })]; },
  setRangeTextDecoration: function (s, e, v) { assert.strictEqual(v, 'NONE'); this.fillGeometry = [{ data: GLYPHS, windingRule: 'NONZERO' }]; } });

// V: "…" truncation: a box that holds 6 characters; Figma shows "abcde…"
var TRUNC_GEOM = [{ data: 'M1 3L60 3L60 15L1 15Z', windingRule: 'NONZERO' }];
function truncText(props) {
  var t = node(props);
  t.clone = function () {
    var c = { characters: t.characters, textAutoResize: t.textAutoResize, textTruncation: t.textTruncation, maxLines: null,
              width: t.width, fixedH: t.height, absoluteTransform: t.absoluteTransform };
    Object.defineProperty(c, 'height', { get: function () { return c.textAutoResize === 'HEIGHT' ? 20 * Math.ceil(c.characters.length / 6) : c.fixedH; } });
    Object.defineProperty(c, 'fillGeometry', { get: function () { return c.characters === 'abcde…' ? TRUNC_GEOM : [{ data: 'M0 0L1 1Z', windingRule: 'NONZERO' }]; } });
    c.deleteCharacters = function (s, e) { c.characters = c.characters.slice(0, s) + c.characters.slice(e); };
    c.insertCharacters = function (i, s) { c.characters = c.characters.slice(0, i) + s + c.characters.slice(i); };
    c.resize = function (w, h) { c.width = w; c.fixedH = h; };
    c.getStyledTextSegments = function () { return [textSeg(c.characters)]; };
    c.remove = function () { var i = pageChildren.indexOf(c); if (i >= 0) pageChildren.splice(i, 1); };
    return c;
  };
  return t;
}
var trunc = truncText({ type: 'TEXT', name: 'trunc', x: 220, y: 560, width: 70, height: 20,
  characters: 'abcdefghijkl', textAutoResize: 'NONE', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP',
  paragraphSpacing: 0, paragraphIndent: 0, textTruncation: 'ENDING', fills: [solid(0, 0, 0)], fillGeometry: TRUNC_GEOM,
  getStyledTextSegments: function () { return [textSeg('abcdefghijkl')]; } });

// W: a node that throws while being read: the export must survive with Figma's pixels for it
var broken = node({ type: 'RECTANGLE', name: 'broken', x: 340, y: 550, width: 20, height: 20,
  fillGeometry: [{ data: rectPath(20, 20), windingRule: 'NONZERO' }],
  exportAsync: function () { return Promise.resolve(solidPng(40, 40, [255, 0, 255, 255])); } });
Object.defineProperty(broken, 'fills', { get: function () { throw new Error('boom'); } });

// X: rect rotated 90deg (box 50..70 x 605..635), hard shadow DOWN on the page
var rotShadow = node({ type: 'RECTANGLE', name: 'rotShadow', x: 0, y: 0, width: 30, height: 20,
  absoluteTransform: [[0, -1, FX + 70], [1, 0, FY + 605]],
  fills: [solid(0, 0, 1)], fillGeometry: [{ data: rectPath(30, 20), windingRule: 'NONZERO' }],
  effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 12 }, radius: 0, spread: 0, blendMode: 'NORMAL' }] });

// Y: rotation 30deg after shear 0.5 (shape layer: the shear runs in comp space along the rotated axis)
var SKEW_ROT = [Math.cos(a30), Math.sin(a30), Math.cos(a30) * 0.5 - Math.sin(a30), Math.sin(a30) * 0.5 + Math.cos(a30), 160, 580];
var skewRot = node({ type: 'RECTANGLE', name: 'skewRot', x: 0, y: 0, width: 40, height: 40,
  absoluteTransform: [[SKEW_ROT[0], SKEW_ROT[2], FX + SKEW_ROT[4]], [SKEW_ROT[1], SKEW_ROT[3], FY + SKEW_ROT[5]]],
  fills: [solid(1, 0, 0)], fillGeometry: [{ data: rectPath(40, 40), windingRule: 'NONZERO' }] });

// Z: flipped clipping frame (box 270..300 x 600..630) with a hard shadow to the right: precomp, layer-space effect
var flipFrame = node({ type: 'FRAME', name: 'flipFrame', x: 0, y: 0, width: 30, height: 30, clipsContent: true,
  absoluteTransform: [[-1, 0, FX + 300], [0, 1, FY + 600]], children: [],
  fills: [solid(0, 0, 1)], fillGeometry: [{ data: rectPath(30, 30), windingRule: 'NONZERO' }],
  effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 12, y: 0 }, radius: 0, spread: 0, blendMode: 'NORMAL' }] });

// AA: marked "rasterize on export": Figma's pixels (cyan) instead of the red vector
var pixels = node({ type: 'RECTANGLE', name: 'pixels', x: 340, y: 600, width: 20, height: 20,
  fills: [solid(1, 0, 0)], fillGeometry: [{ data: rectPath(20, 20), windingRule: 'NONZERO' }],
  getPluginData: function (k) { return k === 'fig2ae-raster' ? '1' : ''; },
  exportAsync: function () { return Promise.resolve(solidPng(40, 40, [0, 255, 255, 255])); } });

var frame = node({ type: 'FRAME', name: 'Scene', x: 0, y: 0, width: 400, height: 660, clipsContent: true,
  exportAsync: function () { return Promise.resolve(solidPng(400, 660, [255, 0, 255, 255])); },
  fills: [solid(1, 1, 1)], fillGeometry: [{ data: rectPath(400, 660), windingRule: 'NONZERO' }],
  children: [linH, linD, radial, blend, rot, maskGroup, text, fallback, gradText, shadow, avatar, blurImg, conic, inner, diamond, fade, tri, tiny, icon,
             card, skew, flipShadow, spread, underline, trunc, broken, rotShadow, skewRot, flipFrame, pixels] });
[frame, maskGroup, tiny, card].forEach(function (p) { p.children.forEach(function (c) { c.parent = p; }); });

/* ----------------------------------------------------- run the plugin */

var handler = null, result = null, created = [];
var figma = {
  mixed: MIXED,
  root: { documentColorProfile: 'SRGB' },
  on: function () {},
  clientStorage: { getAsync: function () { return Promise.resolve(null); }, setAsync: function () { return Promise.resolve(); } },
  currentPage: { name: 'Page 1', selection: [frame], appendChild: function (c) { pageChildren.push(c); } },
  loadFontAsync: function () { return Promise.resolve(); },
  getImageByHash: function (hash) {
    assert.strictEqual(hash, 'h-green');
    return { getSizeAsync: function () { return Promise.resolve({ width: 80, height: 80 }); },
             getBytesAsync: function () { return Promise.resolve(solidPng(80, 80, [0, 255, 0, 255])); } };
  },
  createRectangle: function () { throw new Error('без фильтров картинка не должна перерисовываться'); },
  createText: function () {
    var t = { characters: '', fontSize: 12, remove: function () { created.splice(created.indexOf(t), 1); } };
    Object.defineProperty(t, 'height', { get: function () { return t.characters.split('\n').length * Math.round(t.fontSize * 1.15); } });
    created.push(t);
    return t;
  },
  showUI: function () {}, closePlugin: function () {},
  ui: { postMessage: function (m) { if (m.type === 'file' || m.type === 'error') result = m; }, set onmessage(fn) { handler = fn; }, get onmessage() { return handler; } }
};
var ctx = { figma: figma, __html__: '', console: console, Promise: Promise, Math: Math, JSON: JSON, String: String, Object: Object };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'figma-plugin/code.js'), 'utf8'), ctx);

handler({ type: 'export', opts: { fps: 25, duration: 2, scale: 2, hidden: false, reference: true } }).then(function () {
  assert.ok(result, 'плагин ничего не вернул');
  assert.strictEqual(result.type, 'file', result.message);
  assert.ok(/\.jsx$/.test(result.name), 'плагин должен сохранять готовый .jsx');
  assert.strictEqual(fs.readFileSync(build.UI, 'utf8'), build.uiHtml(), 'ui.html устарел — запусти node build.js');
  assert.strictEqual(pageChildren.length, 0, 'временные клоны не убраны');
  assert.strictEqual(created.length, 0, 'временные текстовые узлы не убраны');
  var doc = JSON.parse(result.json);
  var L = {};
  doc.comp.layers.forEach(function (l) { L[l.name] = l; });

  assert.strictEqual(doc.comp.w, 400);
  assert.strictEqual(doc.comp.layers[0].name, 'Scene · background');

  // linear, 2 stops -> Gradient Ramp effect on a white shape; pixel-space isolines, not Figma handles
  var rB = L.linD.fx.ramp;
  assert.ok(rB, 'двухстоповый градиент должен стать Gradient Ramp');
  assert.strictEqual(rB.shape, 1);
  var gx = 0.5 / 160, gy = 0.5 / 60, g2 = gx * gx + gy * gy;
  near(rB.end[0] - rB.start[0], gx / g2); near(rB.end[1] - rB.start[1], gy / g2);
  assert.deepStrictEqual(L.linD.groups[0].paint.color, [1, 1, 1]);

  // radial ellipse: Gradient Ramp can't, stays a shape gradient
  var pC = L.radial.groups[0].paint;
  assert.strictEqual(pC.kind, 'radial');
  assert.ok(!L.radial.fx);
  near(pC.center[0], 90); near(pC.center[1], 30);
  near(pC.m[0], 90); near(pC.m[3], 30); near(pC.m[1], 0); near(pC.m[2], 0);

  // stacked fills keep order and per-paint blend
  assert.strictEqual(L.blend.groups.length, 2);
  assert.strictEqual(L.blend.groups[1].paint.blend, 'MULTIPLY');

  // rotation survives, stroke stays live
  near(L.rot.rot, 30); near(L.rot.pos[0], 320); near(L.rot.pos[1], 130);
  assert.ok(L.rot.groups[1].stroke, 'CENTER-обводка должна остаться живой');

  // mask -> precomp with matte
  var m = L['mask · masked'];
  assert.ok(m && m.matte, 'маска должна стать трек-маттом');
  assert.strictEqual(m.comp.w, 80);
  assert.strictEqual(m.matte.mode, 'ALPHA');

  // text: two styles, measured auto line height, ink outline + matrix
  assert.strictEqual(L.text.text.segs.length, 2);
  assert.strictEqual(L.text.text.segs[1].style, 'Bold');
  near(L.text.text.segs[0].leading, Math.round(24 * 1.15));
  assert.ok(L.text.text.outline.length);
  near(L.text.text.m[4], 120); near(L.text.text.m[5], 190);

  // gradient text, 2 stops: ONE live text layer with a Gradient Ramp, no matte
  var gt = L.gradText;
  assert.strictEqual(gt.type, 'text');
  assert.ok(gt.fx && gt.fx.ramp && !gt.matte);
  assert.deepStrictEqual(gt.text.segs[0].color, [1, 1, 1]);
  assert.ok(!doc.warnings.some(function (w) { return /gradText/.test(w); }), 'градиентный текст не должен растрироваться');

  // alpha fade -> flat colour + Linear Wipe from the transparent end
  assert.deepStrictEqual(L.fade.fx.solid, [0, 0, 0]);
  near(L.fade.fx.wipe.from[0], 0); near(L.fade.fx.wipe.to[0], 160);
  // three stops -> 4-Color Gradient with points on the gradient line
  var f4 = L.tri.fx.four;
  assert.strictEqual(f4.points.length, 4);
  near(f4.points[1][0], 160 * 0.404);
  assert.deepStrictEqual(f4.colors[2], f4.colors[1], 'для 3 стопов дублируется средний');

  // fractional letter-spacing reaches AE as a fraction; AE side must round it
  assert.ok(Math.abs(L.text.text.segs[0].tracking - (-0.08 / 24 * 1000)) < 1e-6);
  // tiny clipping frame -> 3x3 precomp (AE side clamps to 4)
  assert.strictEqual(L.tiny.type, 'precomp'); assert.strictEqual(L.tiny.comp.w, 3);

  // shadow direction: offset (12,12) -> 135deg, distance 12*sqrt2
  near(L.shadow.effects[0].dir, 135); near(L.shadow.effects[0].dist, 12 * Math.SQRT2);

  // picture: the original 80x80 image, FILL-scaled to 50%, matted by the ellipse
  assert.strictEqual(L.avatar.type, 'image');
  assert.strictEqual(L.avatar.png.w, 80); assert.strictEqual(L.avatar.png.ext, 'png');
  near(L.avatar.scale[0], 50); near(L.avatar.pos[0], 240); near(L.avatar.pos[1], 240);
  assert.strictEqual(L.avatar.matte.layer.type, 'shape');
  assert.ok(!doc.comp.layers.some(function (l) { return l.type === 'image' && l.png.scale !== 1 && !/^(broken|pixels|Figma reference)$/.test(l.name); }), 'ничего не должно растрироваться');

  // blurred picture: precomp (picture + matte inside), Box Blur on the precomp
  assert.strictEqual(L.blurImg.type, 'precomp');
  assert.strictEqual(L.blurImg.effects[0].type, 'BOXBLUR');
  assert.strictEqual(L.blurImg.comp.layers[0].type, 'image');
  assert.ok(L.blurImg.comp.layers[0].matte);

  // angular: wedge fan with matte; diamond: 4 exact linear quadrants
  assert.strictEqual(L['conic · gradient'].groups.length, 180);
  assert.ok(L['conic · gradient'].matte);
  var dq = L['diamond · gradient'].groups;
  assert.strictEqual(dq.length, 4);
  dq.forEach(function (g) { assert.strictEqual(g.paint.kind, 'linear'); });

  // inner shadow: editable hole construction over the fill, clipped to the shape
  var ish = L['inner · inner shadow'];
  assert.ok(ish && ish.matte && ish.groups[0].hole, 'inner shadow должен быть векторной конструкцией');
  assert.deepStrictEqual(ish.groups[0].hole.offset, [0, 8]);
  assert.ok(L.inner, 'заливка узла остаётся отдельным слоем');

  // rounded clipping frame: children clipped by its outline, the outside border is not cut and sits on top
  assert.strictEqual(L.card.type, 'precomp');
  assert.strictEqual(L.card.comp.w, 88, 'прекомп фрейма расширен на внешнюю обводку');
  var cl = L.card.comp.layers.filter(function (l) { return l.name === 'card · content'; })[0];
  assert.ok(cl && cl.matte && cl.matte.layer.type === 'shape', 'дети скруглённого фрейма обрезаются маттом по его форме');
  assert.strictEqual(L.card.comp.layers[L.card.comp.layers.length - 1].name, 'card · stroke', 'обводка фрейма поверх детей');

  // shear -> Transform effect in AE; rotation/scale untouched
  near(L.skew.shear, 0.5); near(L.skew.rot, 0); near(L.skew.scale[1], 100);

  // shape layers take effect params in comp space: flip/rotation don't touch the shadow direction
  near(L.flipShadow.scale[0], -100);
  near(L.flipShadow.effects[0].dir, 90); near(L.flipShadow.effects[0].dist, 12);
  near(L.rotShadow.rot, 90); near(L.rotShadow.effects[0].dir, 180);
  // precomps take them in layer space: the flip is undone
  assert.strictEqual(L.flipFrame.type, 'precomp'); near(L.flipFrame.scale[0], -100);
  near(L.flipFrame.effects[0].dir, -90);

  // spread: the shadow is a vector layer under the node, grown by Offset Paths
  var spL = L['spread · shadow'];
  assert.ok(spL && spL.groups[0].single && spL.groups[0].spread === 6, 'тень со spread — векторный слой');
  assert.strictEqual(L.spread.effects.length, 0);

  // underline: placement by the glyphs only, the bar is Figma's own shape on its own layer
  assert.strictEqual(L.underline.text.outline.length, 1);
  assert.strictEqual(L.underline.text.outline[0].d, GLYPHS);
  assert.ok(!L.underline.text.deco);
  assert.strictEqual(L['underline · line'].groups[0].paths[0].d, BAR);

  // truncation: AE gets exactly the characters Figma shows
  assert.strictEqual(L.trunc.text.chars, 'abcde…');
  assert.strictEqual(L.trunc.text.segs[0].end, 6);

  // a node that throws: Figma's pixels, the export goes on
  assert.strictEqual(L.broken.type, 'image');
  assert.ok(doc.warnings.some(function (w) { return /broken.*boom/.test(w); }));
  assert.strictEqual(doc.warnings.length, 1, 'лишние предупреждения: ' + doc.warnings.join(' | '));

  // rasterize mark: pixels, no warning; reference: Figma render on top as a hidden locked guide layer
  assert.strictEqual(L.pixels.type, 'image');
  var ref = doc.comp.layers[doc.comp.layers.length - 1];
  assert.strictEqual(ref.name, 'Figma reference');
  assert.ok(ref.guide && ref.hidden && ref.locked && ref.type === 'image');
  assert.strictEqual(fs.readFileSync(build.CEP_RT, 'utf8'), build.cepRuntime(), 'cep/runtime.js устарел — запусти node build.js');

  var out = path.join(ROOT, 'test/out');
  if (!fs.existsSync(out)) fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'scene.json'), result.json);
  // exactly what the plugin UI downloads
  fs.writeFileSync(path.join(out, 'scene.jsx'), build.makeJsx(result.json, build.runtime()));

  // AEUX "Precomp groups" off: a plain group stays flat, its layers are parented to a null named after it
  var gNull = doc.comp.layers.filter(function (l) { return l.type === 'null' && l.name === 'maskGroup'; })[0];
  assert.ok(gNull && gNull.gid, 'плоская группа должна дать null');
  var tagged = doc.comp.layers.filter(function (l) { return l.group === gNull.gid; });
  assert.ok(tagged.length > 0, 'слои группы привязаны к её null');
  tagged.forEach(function (l) { if (l.matte && l.type !== 'bgblur') assert.strictEqual(l.matte.layer.group, gNull.gid, 'матт едет вместе со слоем'); });
  assert.ok(!L.linH.groups[0].param, 'без опции — обычные пути');

  var first = doc;
  return handler({ type: 'export', opts: { fps: 25, duration: 2, scale: 2, hidden: false, reference: false, precompGroups: true, parametric: true } }).then(function () {
    var d2 = JSON.parse(result.json), L2 = {};
    d2.comp.layers.forEach(function (l) { L2[l.name] = l; });
    assert.ok(!d2.comp.layers.some(function (l) { return l.type === 'null'; }), 'с Precomp groups нулей нет');
    assert.strictEqual(L2.maskGroup.type, 'precomp', 'группа стала прекомпом');
    var pr = L2.linH.groups[0].param;
    assert.ok(pr && pr.kind === 'rect', 'прямоугольник — параметрический');
    near(pr.size[0], 160); near(pr.size[1], 60);
    assert.ok(L2.blend.groups[0].param && L2.blend.groups[1].param, 'и у сплошных заливок');
    console.log('figma: all checks passed (' + first.warnings.length + ' warnings) -> test/out/scene.jsx');
  });
}).catch(function (e) { console.error(e); process.exit(1); });
