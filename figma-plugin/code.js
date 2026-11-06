/**
 * Fig2AE — Figma side.
 *
 * Rule: everything that is not a picture stays editable in AE (shapes, live
 * text, AE gradients, effects, mattes). Pictures travel as the ORIGINAL image,
 * uncropped, with the node's shape as a separate vector matte, so the picture
 * can still be moved/scaled inside its shape. Whatever cannot be reproduced
 * exactly is listed in the warnings — never approximated silently.
 *
 * Known AEUX bugs this file avoids on purpose:
 *  - linear gradients taken from Figma handles (wrong angle on non-square shapes)
 *  - radial gradients forced to circles (Figma's default radial is an ellipse)
 *  - gradient paint opacity dropped
 *  - shadow angle via atan instead of atan2 (flips for negative X offsets)
 */

// Plugin API arrays are back-to-front: index 0 is painted first (bottom).
var PAINT_LAST_ON_TOP = true;

// Figma blur radius R  ==  CSS box-shadow blur 1.136·R  ==  Gaussian sigma 0.568·R
// (bjango.com/articles/blurradiuscomparison). AE converts sigma with constants
// calibrated in AE itself (test/ae/calibrate.jsx).
var FIGMA_BLUR_TO_SIGMA = 1.136364 / 2;

// angular gradients become a fan of solid wedges: 2 degrees each is below one
// 8-bit colour step for any full-circle ramp
var CONIC_WEDGES = 180;

var WHITE = { kind: 'solid', color: [1, 1, 1], opacity: 100, blend: 'NORMAL' };

var W = [];
function warn(node, text) {
  var line = (node ? '"' + node.name + '": ' : '') + text;
  if (W.indexOf(line) < 0) W.push(line);
}

figma.showUI(__html__, { width: 300, height: 420, themeColors: true });

// "Rasterize layer on export" (like AEUX): a mark stored on the node itself, kept in the file
var RASTER_KEY = 'fig2ae-raster';
function rasterMarked(n) { try { return n.getPluginData(RASTER_KEY) === '1'; } catch (e) { return false; } }

function postSelection() {
  var sel = figma.currentPage.selection, marked = 0;
  for (var i = 0; i < sel.length; i++) if (rasterMarked(sel[i])) marked++;
  figma.ui.postMessage({ type: 'sel', count: sel.length, marked: marked });
}
figma.on('selectionchange', postSelection);

(async function () {
  var opts = null;
  var log = null;
  try { opts = await figma.clientStorage.getAsync('opts'); } catch (e) {}
  try { log = await figma.clientStorage.getAsync('log'); } catch (e) {}
  figma.ui.postMessage({ type: 'init', opts: opts || null, log: log || [] });
  postSelection();
})();

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'close') { figma.closePlugin(); return; }
  if (msg.type === 'resize') { try { figma.ui.resize(300, Math.max(200, Math.min(640, Math.round(msg.h) || 420))); } catch (e) {} return; }
  if (msg.type === 'saveOpts') { try { await figma.clientStorage.setAsync('opts', msg.opts); } catch (e) {} return; }
  if (msg.type === 'saveLog') { try { await figma.clientStorage.setAsync('log', msg.log); } catch (e) {} return; }
  if (msg.type === 'toggleRaster') {
    var sel = figma.currentPage.selection, on = false;
    for (var i = 0; i < sel.length; i++) if (!rasterMarked(sel[i])) on = true;   // any unmarked -> mark all
    try { for (var k = 0; k < sel.length; k++) sel[k].setPluginData(RASTER_KEY, on ? '1' : ''); }
    catch (e) { figma.ui.postMessage({ type: 'error', message: 'Could not mark the layers (read-only file?)' }); }
    postSelection();
    return;
  }
  if (msg.type !== 'export') return;
  W = [];
  var diag = diagnostics(), t0 = Date.now();
  try {
    var doc = await buildDoc(msg.opts);
    var json = JSON.stringify(doc);
    diag.secs = (Date.now() - t0) / 1000; diag.layers = countLayers(doc.comp.layers);
    figma.ui.postMessage({ type: 'file', name: 'fig2ae_' + safeName(doc.comp.name) + '.jsx', json: json, warnings: W, bytes: json.length, diag: diag });
  } catch (e) {
    diag.secs = (Date.now() - t0) / 1000; diag.stack = e && e.stack ? String(e.stack).split('\n').slice(0, 10).join('\n') : '';
    figma.ui.postMessage({ type: 'error', message: (e && e.message) ? e.message : String(e), warnings: W, diag: diag });
  }
};

/** what the "copy log" button needs to know about the file and the selection (names only, no content) */
function diagnostics() {
  var d = { editor: figma.editorType, api: figma.apiVersion, file: '', page: '', selection: [] };
  try { d.file = figma.root.name; d.page = figma.currentPage.name; } catch (e) {}
  try {
    var sel = figma.currentPage.selection;
    for (var i = 0; i < sel.length && i < 10; i++) {
      var n = sel[i];
      d.selection.push(n.type + ' "' + n.name + '" ' + Math.round(n.width || 0) + '×' + Math.round(n.height || 0) +
                       ('children' in n ? ', ' + countNodes(n) + ' nodes' : ''));
    }
    if (sel.length > 10) d.selection.push('… ' + (sel.length - 10) + ' more');
  } catch (e) {}
  try { d.p3 = figma.root.documentColorProfile; } catch (e) {}
  return d;
}
function countNodes(n) { var c = 1; if ('children' in n) for (var i = 0; i < n.children.length; i++) c += countNodes(n.children[i]); return c; }
function countLayers(ls) { var c = 0; for (var i = 0; i < ls.length; i++) { c++; if (ls[i].matte) c++; if (ls[i].comp) c += countLayers(ls[i].comp.layers); } return c; }

function safeName(s) { return String(s).replace(/[^\w\dА-Яа-яЁё\-_ ]+/g, '').replace(/\s+/g, '_').substring(0, 40) || 'comp'; }

/* ------------------------------------------------------------------ doc */

async function buildDoc(o) {
  P3 = false;
  try { P3 = figma.root.documentColorProfile === 'DISPLAY_P3'; } catch (e) {}
  imageCache = {};
  groupSeq = 0;

  var sel = figma.currentPage.selection;
  if (!sel.length) throw new Error('Nothing selected. Select a frame or layers.');

  var comp;
  if (sel.length === 1 && isContainer(sel[0])) {
    var n = sel[0];
    var M = inv(m32(n.absoluteTransform));      // comp space = the frame's own space
    var layers = [], cw = Math.max(1, Math.round(n.width)), ch = Math.max(1, Math.round(n.height));
    if (rasterMarked(n)) await pushRaster(n, M, o, layers);
    else await containerContent(n, M, o, layers, cw, ch, false);
    comp = { name: n.name, w: cw, h: ch, layers: layers };
    if (o.reference) await pushReference(n, M, o, layers, '');
  } else {
    var bb = unionBounds(sel);
    if (!bb) throw new Error('The selection has no visible bounds.');
    var M2 = [1, 0, 0, 1, -bb.x, -bb.y];
    var layers2 = [];
    await emitChildren(sel, M2, layers2, o);
    comp = { name: sel.length === 1 ? sel[0].name : figma.currentPage.name, w: Math.max(1, Math.ceil(bb.width)), h: Math.max(1, Math.ceil(bb.height)), layers: layers2 };
    if (o.reference) for (var r = 0; r < sel.length; r++) if (visible(sel[r])) await pushReference(sel[r], M2, o, layers2, sel.length > 1 ? sel[r].name : '');
  }
  if (gamutClipped) warn(null, 'the file is Display P3: some colours are outside sRGB and were clipped to the nearest');

  return { v: 3, app: 'fig2ae', target: o.target || null, fps: o.fps, duration: o.duration, scale: o.scale, comp: comp, warnings: W };
}

/* ------------------------------------------------------------ dispatch */

function isContainer(n) {
  return n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'COMPONENT' ||
         n.type === 'COMPONENT_SET' || n.type === 'INSTANCE' || n.type === 'SECTION';
}
function visible(n) { return n.visible !== false; }
function realBlend(b) { return !!b && b !== 'PASS_THROUGH' && b !== 'NORMAL'; }
function liveEffects(n, type) {
  var out = [], fx = n.effects || [];
  for (var i = 0; i < fx.length; i++) if (fx[i].visible !== false && (!type || fx[i].type === type)) out.push(fx[i]);
  return out;
}
function hasEffect(n, type) { return liveEffects(n, type).length > 0; }
/** effects that belong to the node as a whole (go on its layer or its precomp) */
function groupEffects(n) { return hasEffect(n, 'DROP_SHADOW') || hasEffect(n, 'LAYER_BLUR'); }

function warnUnsupportedEffects(node) {
  if (hasEffect(node, 'GLASS')) warn(node, 'Glass effect — AE has no exact equivalent, skipped');
}

/** effects AE can't reproduce but Figma renders into the node's own pixels: exact PNG beats a skipped effect */
function bakedEffect(node) {
  if (hasEffect(node, 'NOISE')) return 'Noise effect';
  if (hasEffect(node, 'TEXTURE')) return 'Texture effect';
  var b = liveEffects(node, 'LAYER_BLUR');
  for (var i = 0; i < b.length; i++) if (b[i].blurType === 'PROGRESSIVE') return 'progressive blur';
  return null;
}

/** children in order; a mask takes everything above it into a matted precomp */
async function emitChildren(kids, M, out, o) {
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    if (k.isMask && visible(k)) {
      var L = await maskedLayer(k, kids.slice(i + 1), M, o);
      if (L) out.push(L);
      return;
    }
    await emitNode(k, M, out, o);
  }
}

/** one broken node never kills the export: whatever it drew so far is dropped, Figma's pixels take its place */
async function emitNode(node, M, out, o) {
  var n0 = out.length;
  try {
    await emitNodeExact(node, M, out, o);
  } catch (e) {
    out.length = n0;
    warn(node, 'could not be read (' + ((e && e.message) || e) + ') — baked to PNG');
    await pushRaster(node, M, o, out);
  }
}

async function emitNodeExact(node, M, out, o) {
  if (!visible(node) && !o.hidden) return;
  if (node.type === 'SLICE' || node.type === 'STICKY' || node.type === 'CONNECTOR' || node.type === 'WIDGET') return;
  if (rasterMarked(node)) { bgBlur(node, M, out); return pushRaster(node, M, o, out); }   // the user asked for pixels
  warnUnsupportedEffects(node);
  var baked = bakedEffect(node);
  if (baked) {
    warn(node, baked + ' — no AE equivalent, layer baked to PNG (exact, not editable)');
    bgBlur(node, M, out);
    return pushRaster(node, M, o, out);
  }

  if (isContainer(node)) {
    var grouped = node.clipsContent === true || node.opacity < 1 || realBlend(node.blendMode) ||
                  groupEffects(node) || hasEffect(node, 'INNER_SHADOW') ||
                  (o.precompGroups && node.children && node.children.length > 0);   // AEUX "Precomp groups"
    if (grouped) {
      var p = await precompLayer(node, M, o);
      if (p) { bgBlur(node, M, out); out.push(p); }
      return;
    }
    // flattened group: its layers stay in this comp, parented to a null named after the group (like AEUX)
    var start = out.length, gid = o.groupNulls === false ? null : pushGroupNull(node, M, out);
    await emitSelf(node, M, o, out, false, 'fills');
    await emitChildren(node.children, M, out, o);
    await emitSelf(node, M, o, out, true, 'strokes');
    if (gid) {
      if (out.length === start + 1) out.length = start;          // nothing inside: no null either
      else for (var g = start + 1; g < out.length; g++) tagGroup(out[g], gid);
    }
    return;
  }

  if (node.type !== 'TEXT' && !('fillGeometry' in node)) {
    warn(node, 'type ' + node.type + ' — baked to PNG');
    return pushRaster(node, M, o, out);
  }
  await emitLeaf(node, M, o, out);
}

var groupSeq = 0;
/** a null for a flattened Figma group; its layers get parented to it in AE */
function pushGroupNull(node, M, out) {
  var w = node.width || 1, h = node.height || 1;
  var x = xform(node, mul(M, m32(node.absoluteTransform)), w, h);
  var gid = 'g' + (++groupSeq);
  out.push({ type: 'null', gid: gid, name: node.name, anchor: [50, 50], pos: x.pos, rot: x.rot,
             scale: [x.scale[0] < 0 ? -100 : 100, x.scale[1] < 0 ? -100 : 100],
             opacity: 100, blend: 'NORMAL', effects: [], hidden: !visible(node), locked: false });
  return gid;
}
/** the innermost group wins: layers already tagged by a nested group keep their own null */
function tagGroup(L, gid) {
  if (!L || L.group) return;
  L.group = gid;
  if (L.matte) tagGroup(L.type === 'bgblur' ? L.matte : L.matte.layer, gid);
}

async function pushRaster(node, M, o, out) {
  var r = await rasterLayer(node, M, o, {});
  if (r) out.push(r);
}

/** "Export reference image": Figma's own render on top, a hidden locked guide layer to compare against */
async function pushReference(node, M, o, out, suffix) {
  var r = await rasterLayer(node, M, o, {});
  if (!r) return;
  r.name = 'Figma reference' + (suffix ? ' · ' + suffix : '');
  r.opacity = 100; r.blend = 'NORMAL'; r.guide = true; r.hidden = true; r.locked = true;
  out.push(r);
}

/**
 * A shape or text node. One layer when that is enough; several (fills, image +
 * matte, inner shadow, strokes…) otherwise — then node opacity/blend/effects
 * apply to the whole stack, so the stack goes into a precomp when it has any.
 */
async function emitLeaf(node, M, o, out) {
  var parts = await nodeParts(node, M, o, false);
  if (parts === 'RASTER') return pushRaster(node, M, o, out);
  if (!parts.length) return;
  bgBlur(node, M, out);
  var sh = spreadShadows(node), whole = node.opacity < 1 || realBlend(node.blendMode);
  var fx = hasEffect(node, 'LAYER_BLUR') || (!sh.length && hasEffect(node, 'DROP_SHADOW'));
  // vector shadows sit right under the node, unless opacity/blend/blur apply to node + shadow as a whole
  var outside = !sh.length || (!whole && !fx);
  if (sh.length && outside) for (var s = 0; s < sh.length; s++) out.push(shadowLayer(node, M, sh[s]));

  if (parts.length === 1 && !parts[0].matte && outside) {          // simple: node props on the layer itself
    var L = parts[0];
    L.opacity = L.opacity * nodeOpacity(node) / 100;
    if (realBlend(node.blendMode)) L.blend = node.blendMode;
    L.effects = effectsOf(node, L, M, false);
    L.hidden = !visible(node); L.locked = !!node.locked;
    out.push(L);
    return;
  }
  if (!(whole || fx)) {
    for (var i = 0; i < parts.length; i++) out.push(parts[i]);
    return;
  }
  // as a whole: absolute-aligned precomp around everything the node renders
  var rb = node.absoluteRenderBounds || node.absoluteBoundingBox;
  if (!rb) { for (var j = 0; j < parts.length; j++) out.push(parts[j]); return; }
  var innerM = [1, 0, 0, 1, -rb.x, -rb.y];
  var inner = outside ? [] : sh.map(function (e) { return shadowLayer(node, innerM, e); });
  inner = inner.concat(await nodeParts(node, innerM, o, false));
  var w = Math.max(1, Math.ceil(rb.width)), h = Math.max(1, Math.ceil(rb.height));
  var lm = mul(M, [1, 0, 0, 1, rb.x, rb.y]);
  var P = baseLayer(node, xform(node, lm, w, h));
  P.type = 'precomp'; P.size = [w, h];
  P.comp = { name: node.name, w: w, h: h, layers: inner };
  P.effects = effectsOf(node, P, M, hasImage(node));
  out.push(P);
}

/**
 * A container's own background ('fills', under the children) or border
 * ('strokes': Figma draws a frame's stroke over its children).
 */
async function emitSelf(node, M, o, out, noBgBlur, which) {
  var parts = await nodeParts(node, M, o, true, which);
  if (parts === 'RASTER') {
    if (which === 'strokes') return;                  // the fills call baked the whole background, border included
    var r = await rasterLayer(node, M, o, { noChildren: true, noEffects: true });
    if (r) { r.name = node.name + ' · background'; r.opacity = 100; r.blend = 'NORMAL'; out.push(r); }
    return;
  }
  if (parts.length && !noBgBlur) bgBlur(node, M, out);
  for (var i = 0; i < parts.length; i++) out.push(parts[i]);
}

function nodeOpacity(n) { return (n.opacity === undefined ? 1 : n.opacity) * 100; }
function hasImage(n) {
  var f = n.fills;
  if (!f || f === figma.mixed) return false;
  for (var i = 0; i < f.length; i++) if (f[i].visible !== false && f[i].type === 'IMAGE') return true;
  return false;
}

/* ----------------------------------------------------------- transform */

function m32(t) { return [t[0][0], t[1][0], t[0][1], t[1][1], t[0][2], t[1][2]]; } // figma 2x3 -> [a,b,c,d,tx,ty]
function mul(m, k) {
  return [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1],
          m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3],
          m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]];
}
function inv(m) {
  var det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
          (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
function apply(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
function decompose(m) {
  var a = m[0], b = m[1], c = m[2], d = m[3];
  var sx = Math.sqrt(a * a + b * b);
  if (sx > 0) { a /= sx; b /= sx; }
  var shear = a * c + b * d;
  c -= a * shear; d -= b * shear;
  var sy = Math.sqrt(c * c + d * d);
  if (sy > 0) { c /= sy; d /= sy; shear /= sy; }
  if (a * d - b * c < 0) { a = -a; b = -b; sx = -sx; }
  // m = R(rot) * diag(sx, sy) * [[1, t], [0, 1]]: AE layer transform + a horizontal shear in layer space
  var k = a * m[2] + b * m[3];
  return { rot: Math.atan2(b, a) * 180 / Math.PI, sx: sx, sy: sy, t: Math.abs(sx) > 1e-9 ? k / sx : 0 };
}

/** layer transform for a local box (w x h) placed by matrix lm, anchor centred; shear goes to a Transform effect in AE */
function xform(node, lm, w, h) {
  var d = decompose(lm);
  var x = { anchor: [w / 2, h / 2], pos: apply(lm, [w / 2, h / 2]), rot: d.rot, scale: [d.sx * 100, d.sy * 100] };
  if (Math.abs(d.t) > 1e-4) x.shear = d.t;
  return x;
}

function unionBounds(nodes) {
  var b = null;
  for (var i = 0; i < nodes.length; i++) {
    var r = nodes[i].absoluteRenderBounds || nodes[i].absoluteBoundingBox;
    if (!r) continue;
    if (!b) b = { x: r.x, y: r.y, x2: r.x + r.width, y2: r.y + r.height };
    else { b.x = Math.min(b.x, r.x); b.y = Math.min(b.y, r.y); b.x2 = Math.max(b.x2, r.x + r.width); b.y2 = Math.max(b.y2, r.y + r.height); }
  }
  return b ? { x: b.x, y: b.y, width: b.x2 - b.x, height: b.y2 - b.y } : null;
}

/* --------------------------------------------------------------- color */

var P3 = false, gamutClipped = false;
function lin(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function enc(v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
function clip01(v) {
  if (v < -0.002 || v > 1.002) gamutClipped = true;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}
/** Figma color -> sRGB [r,g,b]. Display-P3 documents are converted, AE assumes sRGB. */
function col(c) {
  if (!P3) return [c.r, c.g, c.b];
  var r = lin(c.r), g = lin(c.g), b = lin(c.b);
  return [
    clip01(enc(1.2249401 * r - 0.2249404 * g)),
    clip01(enc(-0.0420569 * r + 1.0420571 * g)),
    clip01(enc(-0.0196376 * r - 0.0786361 * g + 1.0982735 * b))
  ];
}

/* --------------------------------------------------------------- paint */

function stopsOf(p) {
  var stops = [];
  for (var i = 0; i < p.gradientStops.length; i++) {
    var s = p.gradientStops[i];
    stops.push({ pos: s.position, color: col(s.color), a: s.color.a === undefined ? 1 : s.color.a });
  }
  return stops;
}

/**
 * One Figma paint -> paint record in node-local pixels:
 *   solid / linear / radial  -> drawn by an AE shape fill (exact)
 *   angular / diamond        -> built from vector pieces under a matte (editable)
 *   image                    -> original picture under a matte
 *   'RASTER'                 -> video / pattern: pixels from Figma
 */
function paintRec(p, w, h) {
  var op = (p.opacity === undefined ? 1 : p.opacity) * 100;
  var blend = p.blendMode || 'NORMAL';
  if (p.type === 'SOLID') return { kind: 'solid', color: col(p.color), opacity: op, blend: blend };
  if (p.type === 'IMAGE') return { kind: 'image', raw: p, opacity: op, blend: blend };
  if (p.type.indexOf('GRADIENT_') !== 0) return 'RASTER';

  var stops = stopsOf(p);
  // normalized node space -> gradient space is T; node px -> normalized is diag(1/w,1/h)
  var T = m32(p.gradientTransform), Ti = inv(T);
  var px = function (q) { var n = apply(Ti, q); return [n[0] * w, n[1] * h]; };

  if (p.type === 'GRADIENT_LINEAR') {
    // g(p) = T00*x/w + T01*y/h + T02 ; isolines are perpendicular to grad(g) IN PIXELS,
    // which is not the Figma handle line once the shape is non-square.
    var gx = T[0] / w, gy = T[2] / h, g2 = gx * gx + gy * gy;
    if (g2 < 1e-12) return { kind: 'solid', color: stops[0].color, opacity: op * stops[0].a, blend: blend };
    var S = px([0, 0.5]), E = [S[0] + gx / g2, S[1] + gy / g2];
    return { kind: 'linear', stops: stops, opacity: op, blend: blend, start: S, end: E, fx: linearFx(stops, S, E) };
  }
  if (p.type === 'GRADIENT_RADIAL') {
    // unit circle in gradient space (centre .5,.5 radius .5) -> pixels
    var c = px([0.5, 0.5]), ex = px([1, 0.5]), ey = px([0.5, 1]);
    var m = [ex[0] - c[0], ex[1] - c[1], ey[0] - c[0], ey[1] - c[1]];
    var r1 = Math.sqrt(m[0] * m[0] + m[1] * m[1]), r2 = Math.sqrt(m[2] * m[2] + m[3] * m[3]);
    var circle = Math.abs(r1 - r2) < 1e-3 * r1 && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-3 * r1 * r2;
    var rr = circle ? rampOf(stops, 2, c, [c[0] + r1, c[1]]) : null;
    return { kind: 'radial', stops: stops, opacity: op, blend: blend, center: c, m: m,
             fx: rr ? { ramp: rr, alpha: stops[0].a } : null };
  }
  return { kind: p.type === 'GRADIENT_ANGULAR' ? 'angular' : 'diamond', stops: stops, opacity: op, blend: blend, T: T };
}

/**
 * The same gradient as an AE "Gradient Ramp" effect, when that is exact:
 * two stops of equal alpha; radial only as a circle starting at the centre.
 * Points are node-local px from A (position 0) towards B (position 1).
 */
function rampOf(stops, shape, A, B) {
  if (stops.length !== 2 || Math.abs(stops[0].a - stops[1].a) > 1e-3) return null;
  var p0 = stops[0].pos, p1 = stops[1].pos;
  if (p1 - p0 < 1e-4 || (shape === 2 && p0 > 1e-4)) return null;
  var d = [B[0] - A[0], B[1] - A[1]];
  return { shape: shape, start: [A[0] + d[0] * p0, A[1] + d[1] * p0], end: [A[0] + d[0] * p1, A[1] + d[1] * p1],
           c0: stops[0].color, c1: stops[1].color, alpha: stops[0].a };
}

function sameColor(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 3e-3; }

/**
 * A linear gradient as AE effects, when they can carry it:
 *   2 stops, one alpha          -> Gradient Ramp (or a plain colour)
 *   2 stops, alpha 0 -> a       -> colour as above + Linear Wipe for the fade
 *   3-4 stops, one alpha        -> 4-Color Gradient, points on the gradient line (approximate)
 * Otherwise null: the gradient stays an exact shape gradient.
 */
function linearFx(stops, A, B) {
  var n = stops.length, d = [B[0] - A[0], B[1] - A[1]];
  function at(t) { return [A[0] + d[0] * t, A[1] + d[1] * t]; }
  var amin = 1, amax = 0, i;
  for (i = 0; i < n; i++) { amin = Math.min(amin, stops[i].a); amax = Math.max(amax, stops[i].a); }
  if (amax < 1e-3) return null;
  if (n === 2) {
    var fade = amax - amin > 1e-3;
    if (fade && amin > 1e-3) return null;                // wipe fades to zero only
    var fx = { alpha: amax };
    if (sameColor(stops[0].color, stops[1].color)) fx.solid = stops[0].color;
    else {
      if (stops[1].pos - stops[0].pos < 1e-4) return null;
      fx.ramp = { shape: 1, start: at(stops[0].pos), end: at(stops[1].pos), c0: stops[0].color, c1: stops[1].color };
    }
    if (fade) {
      var z = stops[0].a < stops[1].a ? 0 : 1;            // the transparent end
      fx.wipe = { from: at(stops[z].pos), to: at(stops[1 - z].pos) };
    }
    return fx;
  }
  if ((n === 3 || n === 4) && amax - amin < 1e-3) {
    // 3 stops: the middle one doubled — measured in AE: mean error 0.06 vs 0.07 doubling an end
    var order = n === 3 ? [0, 1, 1, 2] : [0, 1, 2, 3], pts = [], cols = [];
    for (i = 0; i < 4; i++) { var s = stops[order[i]]; pts.push(at(s.pos)); cols.push(s.color); }
    return { four: { points: pts, colors: cols }, alpha: amax };
  }
  return null;
}

/** a layer of its own: white (or flat-coloured) fill, gradient applied by AE effects */
function fxLayer(node, M, paths, P, name, param) {
  var L = nodeShape(node, M, [withParam({ paths: paths, paint: { kind: 'solid', color: P.fx.solid || [1, 1, 1], opacity: P.opacity * P.fx.alpha, blend: 'NORMAL' } }, param)], name);
  L.blend = P.blend; L.fx = P.fx;
  return L;
}

function isVectorPaint(r) { return r.kind === 'solid' || r.kind === 'linear' || r.kind === 'radial'; }

/** visible paints bottom->top, or 'RASTER' */
function paintList(list, w, h, node) {
  if (list === figma.mixed) return 'RASTER';
  if (!list) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].visible === false) continue;
    var r = paintRec(list[i], w, h);
    if (r === 'RASTER') {
      warn(node, ({ VIDEO: 'video', PATTERN: 'pattern' }[list[i].type] || list[i].type) + ' — baked to PNG');
      return 'RASTER';
    }
    out.push(r);
  }
  return PAINT_LAST_ON_TOP ? out : out.reverse();
}

function geomPaths(geom) {
  var out = [];
  if (!geom) return out;
  for (var i = 0; i < geom.length; i++) out.push({ d: geom[i].data, evenOdd: geom[i].windingRule === 'EVENODD' });
  return out;
}

/** how a stroke can be reproduced: none | live (animatable AE stroke) | outline (Figma's expanded geometry) */
function strokeMode(node, strokes) {
  if (!strokes.length) return 'none';
  var csp = node.complexStrokeProperties;
  if (csp && csp.type === 'BRUSH') { warn(node, 'brush stroke — outline transferred, the brush texture is not'); return 'outline'; }
  if (csp && csp.type === 'DYNAMIC') return 'outline';
  if (node.variableWidthPoints && node.variableWidthPoints.length) return 'outline';
  if (node.strokeAlign !== 'CENTER') return 'outline';
  if (node.dashPattern && node.dashPattern.length) return 'outline';
  if (node.strokeWeight === figma.mixed) return 'outline';
  if (node.strokeCap !== 'NONE' && node.strokeCap !== 'ROUND' && node.strokeCap !== 'SQUARE') return 'outline'; // arrows, mixed
  if (node.strokeJoin === figma.mixed) return 'outline';
  for (var i = 0; i < strokes.length; i++) if (strokes[i].kind !== 'solid') return 'outline';
  return 'live';
}

function sampleStops(stops, t) {
  if (t <= stops[0].pos) return stops[0];
  for (var i = 1; i < stops.length; i++) {
    if (t <= stops[i].pos) {
      var a = stops[i - 1], b = stops[i], k = (t - a.pos) / Math.max(1e-9, b.pos - a.pos);
      return { color: [a.color[0] + (b.color[0] - a.color[0]) * k, a.color[1] + (b.color[1] - a.color[1]) * k, a.color[2] + (b.color[2] - a.color[2]) * k],
               a: a.a + (b.a - a.a) * k };
    }
  }
  return stops[stops.length - 1];
}

function polyPath(pts) {
  var d = 'M' + pts[0][0] + ' ' + pts[0][1];
  for (var i = 1; i < pts.length; i++) d += 'L' + pts[i][0] + ' ' + pts[i][1];
  return d + 'Z';
}

/** gradient-space radius that covers the node box */
function coverRadius(T) {
  var r = 0, cs = [[0, 0], [1, 0], [0, 1], [1, 1]];
  for (var i = 0; i < 4; i++) { var q = apply(T, cs[i]); r = Math.max(r, Math.sqrt(Math.pow(q[0] - 0.5, 2) + Math.pow(q[1] - 0.5, 2))); }
  return r * 1.5 + 1;
}

/**
 * Angular (conic) gradient as a fan of solid wedges around the gradient centre,
 * angle measured in gradient space from the first handle, clockwise on screen.
 */
function angularGroups(P, w, h) {
  var Ti = inv(P.T), R = coverRadius(P.T), groups = [];
  var step = 2 * Math.PI / CONIC_WEDGES;
  // Opaque: every wedge reaches one step into the next one, which is drawn on top,
  // so no anti-aliased seam can show the background. Translucent wedges can't
  // overlap (alpha would double) — exact edges, faint seams possible.
  var opaque = P.stops.every(function (s) { return s.a >= 0.999; }) && P.opacity >= 99.9;
  function pt(a) { var q = apply(Ti, [0.5 + R * Math.cos(a), 0.5 + R * Math.sin(a)]); return [q[0] * w, q[1] * h]; }
  var c0 = apply(Ti, [0.5, 0.5]), c = [c0[0] * w, c0[1] * h];
  for (var k = 0; k < CONIC_WEDGES; k++) {
    var a0 = step * k, a1 = step * (k + 1);
    if (opaque && k < CONIC_WEDGES - 1) a1 += step;
    if (opaque && k === 0) a0 -= step / 2;     // tucked under the last wedge: closes the 0° seam without moving it
    var s = sampleStops(P.stops, (k + 0.5) / CONIC_WEDGES);
    groups.push({ paths: [{ d: polyPath([c, pt(a0), pt(a1)]), evenOdd: false }],
                  paint: { kind: 'solid', color: s.color, opacity: P.opacity * s.a, blend: 'NORMAL' } });
  }
  return groups;
}

/**
 * Diamond gradient: g = 2(|x-.5|+|y-.5|) in gradient space is LINEAR inside each
 * quadrant, so four linear AE gradients reproduce it exactly.
 */
function diamondGroups(P, w, h) {
  var T = P.T, Ti = inv(T), R = coverRadius(T), e = 0.002, groups = [];
  function px(q) { var n = apply(Ti, q); return [n[0] * w, n[1] * h]; }
  var c = px([0.5, 0.5]);
  [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(function (s) {
    var sx = s[0], sy = s[1];
    var quad = [px([0.5 - e * sx, 0.5 - e * sy]), px([0.5 + R * sx, 0.5 - e * sy]), px([0.5 + R * sx, 0.5 + R * sy]), px([0.5 - e * sx, 0.5 + R * sy])];
    // grad(g) in pixels: g = 2(sx(Gx-.5) + sy(Gy-.5)),  Gx = a x/w + c y/h + e, Gy = b x/w + d y/h + f
    var gx = 2 * (sx * T[0] + sy * T[1]) / w, gy = 2 * (sx * T[2] + sy * T[3]) / h, g2 = gx * gx + gy * gy;
    groups.push({ paths: [{ d: polyPath(quad), evenOdd: false }],
                  paint: { kind: 'linear', stops: P.stops, opacity: P.opacity, blend: 'NORMAL', start: c, end: [c[0] + gx / g2, c[1] + gy / g2] } });
  });
  return groups;
}

/* -------------------------------------------------------------- layers */

function baseLayer(node, x) {
  return {
    name: node.name,
    hidden: !visible(node),
    locked: !!node.locked,
    opacity: nodeOpacity(node),
    blend: node.blendMode || 'NORMAL',
    anchor: x.anchor, pos: x.pos, rot: x.rot, scale: x.scale, shear: x.shear
  };
}

/** a shape layer in the node's own space, neutral props (the caller decides opacity/blend/effects) */
function nodeShape(node, M, groups, name) {
  var w = node.width || 1, h = node.height || 1;
  var L = baseLayer(node, xform(node, mul(M, m32(node.absoluteTransform)), w, h));
  L.type = 'shape'; L.size = [w, h]; L.name = name;
  L.opacity = 100; L.blend = 'NORMAL'; L.effects = []; L.hidden = false; L.locked = false;
  L.groups = groups;
  return L;
}

/** the paint layer for a non-vector paint, matted by `outline` (node-local paths) */
async function mattedPaint(node, M, o, P, outline, name) {
  var w = node.width || 1, h = node.height || 1, L;
  if (P.kind === 'image') {
    L = await imageLayer(node, M, o, P, name);
    if (!L) return null;
  } else {
    L = nodeShape(node, M, P.kind === 'angular' ? angularGroups(P, w, h) : diamondGroups(P, w, h), name);
    L.opacity = 100; L.blend = P.blend;
  }
  L.matte = { layer: nodeShape(node, M, [{ paths: outline, paint: WHITE }], name + ' · shape'), mode: 'ALPHA' };
  return L;
}

/**
 * Every layer that draws one shape node, bottom->top, in space M, with neutral
 * node props. 'RASTER' only for video/pattern paints.
 */
async function nodeParts(node, M, o, selfOnly, which) {
  if (node.type === 'TEXT') return textParts(node, M, o);
  var w = node.width || 1, h = node.height || 1;
  var fills = paintList(node.fills, w, h, node);
  var strokes = paintList(node.strokes, w, h, node);
  if (fills === 'RASTER' || strokes === 'RASTER') return 'RASTER';
  if (which === 'fills') strokes = [];
  if (which === 'strokes') fills = [];
  var label = which === 'strokes' ? node.name + ' · stroke' : selfOnly ? node.name + ' · background' : node.name;
  var fillPaths = geomPaths(node.fillGeometry);
  var param = o.parametric ? parametricOf(node) : null;      // AEUX "Detect parametric shapes"
  var parts = [], run = [], i, L;

  function flush() {
    if (run.length) parts.push(nodeShape(node, M, run, parts.length ? label + ' · ' + (parts.length + 1) : label));
    run = [];
  }

  // fills, in paint order; vector paints share one shape layer
  if (fillPaths.length) {
    for (i = 0; i < fills.length; i++) {
      if (isVectorPaint(fills[i]) && !fills[i].fx) { run.push(withParam({ paths: fillPaths, paint: fills[i] }, param)); continue; }
      flush();
      if (fills[i].fx) { parts.push(fxLayer(node, M, fillPaths, fills[i], parts.length ? label + ' · gradient' : label, param)); continue; }
      L = await mattedPaint(node, M, o, fills[i], fillPaths, fills[i].kind === 'image' ? label : label + ' · gradient');
      if (L) parts.push(L);
    }
  }

  // inner shadows sit over the fills, clipped to the shape
  var inner = liveEffects(node, 'INNER_SHADOW');
  if (inner.length && fillPaths.length && !selfOnly) {   // a container's inner shadow is added over its children
    flush();
    for (i = 0; i < inner.length; i++) parts.push(innerShadowLayer(node, M, inner[i], fillPaths, label));
  }

  // strokes on top
  var mode = strokeMode(node, strokes);
  if (mode === 'live') {
    var base = ('vectorPaths' in node && node.vectorPaths && node.vectorPaths.length) ? geomPaths(node.vectorPaths) : fillPaths;
    if (!base.length) mode = 'outline';
    else for (i = 0; i < strokes.length; i++) {
      run.push(withParam({ paths: base, paint: strokes[i], stroke: { width: node.strokeWeight, cap: node.strokeCap, join: node.strokeJoin, miter: node.strokeMiterLimit || 4 } }, param));
    }
  }
  if (mode === 'outline') {
    // inside/outside/dashed/arrows/variable width: Figma already expanded it exactly
    var sp = geomPaths(node.strokeGeometry);
    if (sp.length) for (i = 0; i < strokes.length; i++) {
      if (isVectorPaint(strokes[i]) && !strokes[i].fx) { run.push({ paths: sp, paint: strokes[i] }); continue; }
      flush();
      if (strokes[i].fx) { parts.push(fxLayer(node, M, sp, strokes[i], label + ' · stroke')); continue; }
      L = await mattedPaint(node, M, o, strokes[i], sp, label + ' · stroke');
      if (L) parts.push(L);
    }
  }
  flush();
  return parts;
}

/**
 * Rectangle / ellipse that AE can draw as a parametric shape (Rect with
 * Roundness, Ellipse): same outline, but Size/Roundness stay animatable.
 * Only when the outline is exactly that: one radius, no smoothing, full ellipse.
 */
function parametricOf(node) {
  var w = node.width, h = node.height;
  if (!(w > 0 && h > 0)) return null;
  if (node.type === 'ELLIPSE') {
    var a = node.arcData;
    if (a && (Math.abs(a.innerRadius || 0) > 1e-6 || Math.abs((a.endingAngle - a.startingAngle) - 2 * Math.PI) > 1e-4)) return null;
    return { kind: 'ellipse', size: [w, h] };
  }
  if (node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    var r = node.cornerRadius;
    if (r === figma.mixed) return null;
    if (r && node.cornerSmoothing) return null;
    return { kind: 'rect', size: [w, h], r: Math.min(r || 0, w / 2, h / 2) };
  }
  return null;
}
function withParam(g, param) { if (param && g.paths.length === 1) g.param = param; return g; }

/**
 * Figma inner shadow, editable: a big rect with a hole shaped like the node
 * (offset by the shadow offset, shrunk by spread), blurred, clipped to the node.
 */
function innerShadowLayer(node, M, e, fillPaths, label) {
  var w = node.width || 1, h = node.height || 1;
  var dx = e.offset.x, dy = e.offset.y, spread = e.spread || 0;
  var pad = Math.abs(dx) + Math.abs(dy) + Math.abs(spread) + 4 * e.radius + 10;
  var big = polyPath([[-pad, -pad], [w + pad, -pad], [w + pad, h + pad], [-pad, h + pad]]);
  var L = nodeShape(node, M, [{
    paths: [{ d: big, evenOdd: true }],
    hole: { paths: fillPaths, offset: [dx, dy], spread: spread },
    paint: { kind: 'solid', color: col(e.color), opacity: (e.color.a === undefined ? 1 : e.color.a) * 100, blend: 'NORMAL' }
  }], label + ' · inner shadow');
  L.blend = e.blendMode || 'NORMAL';
  if (e.radius > 0) L.effects = [{ type: 'BLUR', sigma: e.radius * FIGMA_BLUR_TO_SIGMA }];
  L.matte = { layer: nodeShape(node, M, [{ paths: fillPaths, paint: WHITE }], label + ' · inner shadow · shape'), mode: 'ALPHA' };
  return L;
}

/**
 * Drop shadows with spread: AE's Drop Shadow has none, so the node's shadows
 * become blurred vector copies of its outline, grown by Offset Paths. All of
 * them — a vector shadow under an effect shadow would cast a shadow of its own.
 */
function spreadShadows(node) {
  var fx = liveEffects(node, 'DROP_SHADOW'), any = false;
  for (var i = 0; i < fx.length; i++) if (fx[i].spread) any = true;
  if (!any) return [];
  if (node.type === 'TEXT' || !geomPaths(node.fillGeometry).length || (isContainer(node) && node.clipsContent !== true)) {
    warn(node, 'shadow spread — not supported for this kind of layer, shadow without spread');
    return [];
  }
  return fx;
}

/** one drop shadow as its own layer: the node outline (+ outer border), offset, grown, blurred */
function shadowLayer(node, M, e) {
  var t = m32(node.absoluteTransform), det = t[0] * t[3] - t[1] * t[2];
  var dx = e.offset.x, dy = e.offset.y;                  // page space -> node space
  var off = Math.abs(det) > 1e-12 ? [(t[3] * dx - t[2] * dy) / det, (-t[1] * dx + t[0] * dy) / det] : [dx, dy];
  var paths = geomPaths(node.fillGeometry);
  if (outerStroke(node) > 0) paths = paths.concat(geomPaths(node.strokeGeometry));
  var L = nodeShape(node, M, [{
    paths: paths, single: true, offset: off, spread: e.spread || 0,
    paint: { kind: 'solid', color: col(e.color), opacity: (e.color.a === undefined ? 1 : e.color.a) * 100, blend: 'NORMAL' }
  }], node.name + ' · shadow');
  L.blend = e.blendMode || 'NORMAL';
  if (e.radius > 0) L.effects = [{ type: 'BLUR', sigma: e.radius * FIGMA_BLUR_TO_SIGMA }];
  return L;
}

/**
 * Node effects for AE layer L, which sits in a comp whose space is M(page).
 * Figma shadow offsets are page-space. Measured in AE 26.2 (Drop Shadow on
 * rotated / flipped / scaled layers): shape and text layers apply effects in
 * COMP space (after their transform); pictures and precomps in their own LAYER
 * space (before it) -> there rotation, flip and scale are undone.
 */
function effectsOf(node, L, M, imageBlur) {
  var out = [], fx = liveEffects(node), vector = spreadShadows(node).length > 0;
  var inComp = L.type === 'shape' || L.type === 'text';
  var r = inComp ? 0 : L.rot * Math.PI / 180, sx = inComp ? 1 : L.scale[0] / 100, sy = inComp ? 1 : L.scale[1] / 100;
  var detM = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])), sigmaK = detM / Math.sqrt(Math.abs(sx * sy) || 1);
  for (var i = 0; i < fx.length; i++) {
    var e = fx[i];
    if (e.type === 'DROP_SHADOW') {
      if (vector) continue;                                    // drawn as layers (see shadowLayer)
      var wv = [M[0] * e.offset.x + M[2] * e.offset.y, M[1] * e.offset.x + M[3] * e.offset.y];   // comp space
      var dx = (Math.cos(r) * wv[0] + Math.sin(r) * wv[1]) / sx, dy = (-Math.sin(r) * wv[0] + Math.cos(r) * wv[1]) / sy;
      out.push({
        type: 'SHADOW',
        color: col(e.color),
        opacity: (e.color.a === undefined ? 1 : e.color.a) * 100,
        dist: Math.sqrt(dx * dx + dy * dy),
        dir: Math.atan2(dx, -dy) * 180 / Math.PI,
        sigma: e.radius * FIGMA_BLUR_TO_SIGMA * sigmaK
      });
    } else if (e.type === 'LAYER_BLUR') {
      out.push({ type: imageBlur ? 'BOXBLUR' : 'BLUR', sigma: e.radius * FIGMA_BLUR_TO_SIGMA * sigmaK });
    }
  }
  return out;
}

/**
 * Background blur: an adjustment layer with Gaussian Blur, matted by the node's
 * own outline, placed right under the node. Only blurs what is in the same AE comp.
 */
function bgBlur(node, M, out) {
  var e = liveEffects(node, 'BACKGROUND_BLUR')[0];
  if (!e) return;
  var paths = geomPaths(node.fillGeometry);
  if (!paths.length) { warn(node, 'background blur without a shape — skipped'); return; }
  var matte = nodeShape(node, M, [{ paths: paths, paint: WHITE }], node.name + ' · blur mask');
  out.push({ type: 'bgblur', name: node.name + ' · background blur', sigma: e.radius * FIGMA_BLUR_TO_SIGMA, matte: matte, hidden: !visible(node) });
  warn(node, 'background blur is an adjustment layer — it only blurs layers inside the same comp');
}

/* --------------------------------------------------------------- image */

var imageCache = {};

/** the original picture as PNG/JPEG bytes; image filters (exposure etc.) baked in */
async function imagePixels(p) {
  var f = p.filters || {}, filtered = false;
  for (var k in f) if (f[k]) filtered = true;
  var key = p.imageHash + (filtered ? JSON.stringify(f) : '');
  if (imageCache[key]) return imageCache[key];
  var img = figma.getImageByHash(p.imageHash);
  if (!img) return null;
  var size = await img.getSizeAsync();
  var res = null;
  if (!filtered) {
    var bytes = await img.getBytesAsync();
    var ext = sniff(bytes);
    if (ext) res = { bytes: bytes, ext: ext, w: size.width, h: size.height };
  }
  if (!res) {
    // filters or a format AE can't open (webp, gif…): let Figma render the full image once
    var r = figma.createRectangle();
    try {
      r.resize(size.width, size.height);
      r.fills = [{ type: 'IMAGE', imageHash: p.imageHash, scaleMode: 'FILL', filters: p.filters }];
      var settings = { format: 'PNG', constraint: { type: 'SCALE', value: 1 } };
      if (P3) settings.colorProfile = 'SRGB';
      res = { bytes: await r.exportAsync(settings), ext: 'png', w: size.width, h: size.height };
    } finally { r.remove(); }
  }
  res.b64 = b64(res.bytes);
  delete res.bytes;
  imageCache[key] = res;
  return res;
}

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  return null;
}

/**
 * Matrix: image pixels -> node-local pixels, per Figma scale mode.
 * CROP: imageTransform maps node-normalized -> image-normalized space.
 * Paint rotation is in 90° steps, counter-clockwise like node rotation.
 */
function imagePlacement(p, w, h, iw, ih) {
  if (p.scaleMode === 'CROP' && p.imageTransform) {
    return mul([w, 0, 0, h, 0, 0], mul(inv(m32(p.imageTransform)), [1 / iw, 0, 0, 1 / ih, 0, 0]));
  }
  var rot = (((p.rotation || 0) % 360) + 360) % 360;
  var rw = rot % 180 ? ih : iw, rh = rot % 180 ? iw : ih;
  var s = p.scaleMode === 'FIT' ? Math.min(w / rw, h / rh)
        : p.scaleMode === 'TILE' ? (p.scalingFactor || 1)
        : Math.max(w / rw, h / rh);                                      // FILL
  var a = -rot * Math.PI / 180, c = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a));
  var place = p.scaleMode === 'TILE' ? [s, 0, 0, s, rw * s / 2, rh * s / 2] : [s, 0, 0, s, w / 2, h / 2];
  return mul(place, mul([c, sn, -sn, c, 0, 0], [1, 0, 0, 1, -iw / 2, -ih / 2]));
}

async function imageLayer(node, M, o, P, name) {
  var img = null;
  try { img = await imagePixels(P.raw); } catch (e) { img = null; }
  if (!img) { warn(node, 'could not get the image from Figma — skipped'); return null; }
  var w = node.width || 1, h = node.height || 1;
  var lm = mul(M, mul(m32(node.absoluteTransform), imagePlacement(P.raw, w, h, img.w, img.h)));
  var L = baseLayer(node, xform(node, lm, img.w, img.h));
  L.type = 'image'; L.name = name; L.size = [img.w, img.h];
  L.png = { b64: img.b64, ext: img.ext, w: img.w, h: img.h, scale: 1 };
  L.opacity = P.opacity; L.blend = P.blend; L.effects = []; L.hidden = false; L.locked = false;
  if (P.raw.scaleMode === 'TILE') {
    var tw = img.w * (P.raw.scalingFactor || 1), th = img.h * (P.raw.scalingFactor || 1);
    L.effects = [{ type: 'TILE', nx: 2 * Math.ceil(w / tw) + 1, ny: 2 * Math.ceil(h / th) + 1 }];
  }
  return L;
}

/* ---------------------------------------------------------------- text */

var autoLH = {};
/** Figma's AUTO line height is font-specific; measure it instead of guessing 120% */
async function measureAutoLineHeight(fontName, size) {
  var key = fontName.family + '|' + fontName.style + '|' + size;
  if (key in autoLH) return autoLH[key];
  var t = null, v = null;
  try {
    await figma.loadFontAsync(fontName);
    t = figma.createText();
    t.fontName = fontName; t.fontSize = size; t.lineHeight = { unit: 'AUTO' };
    t.characters = 'A';
    var h1 = t.height;
    t.characters = 'A\nA';
    v = t.height - h1;
  } catch (e) { v = null; }
  finally { if (t) t.remove(); }
  autoLH[key] = v;
  return v;
}

function caseOf(s, tc) {
  if (tc === 'UPPER') return s.toUpperCase();
  if (tc === 'LOWER') return s.toLowerCase();
  if (tc === 'TITLE') return s.replace(/(^|\s)(\S)/g, function (m, a, b) { return a + b.toUpperCase(); });
  return s;
}

/** one live text layer; `segs` decide which characters are filled and how */
function textCopy(node, M, base, segs, stroke, name) {
  var w = node.width, h = node.height;
  var lm = mul(M, m32(node.absoluteTransform));
  var L = baseLayer(node, xform(node, lm, w, h));
  L.type = 'text'; L.size = [w, h]; L.name = name;
  L.opacity = 100; L.blend = 'NORMAL'; L.effects = []; L.hidden = false; L.locked = false;
  L.text = {
    chars: base.chars, segs: segs, box: base.box, align: base.align, valign: base.valign,
    paraSpacing: base.paraSpacing, indent: base.indent, stroke: stroke, deco: !!base.deco,
    outline: base.outline,   // glyph outlines in node space: AE aligns the text by their exact ink box
    m: lm                    // node-local -> comp, so AE can place that ink box exactly
  };
  return L;
}

/**
 * Text node -> layers. Plain coloured text is ONE live text layer. Anything AE
 * text can't paint (gradients, pictures, inside/gradient strokes) becomes live
 * text copies used as mattes over real AE paint layers — every piece editable.
 */
var SEG_FIELDS = ['fontName', 'fontSize', 'letterSpacing', 'lineHeight', 'fills', 'textCase', 'textDecoration', 'listOptions'];

function isDecorated(s) { return !!s.textDecoration && s.textDecoration !== 'NONE'; }

/** subpaths of a Figma geometry, as strings: the same glyph gives the same string */
function subpaths(geom) {
  var out = [];
  for (var i = 0; i < (geom || []).length; i++) {
    var parts = geom[i].data.match(/M[^M]*/g) || [];
    for (var k = 0; k < parts.length; k++) out.push({ d: parts[k], evenOdd: geom[i].windingRule === 'EVENODD' });
  }
  return out;
}
function minusPaths(a, b) {
  var n = {}, out = [], i;
  for (i = 0; i < b.length; i++) n[b[i].d] = (n[b[i].d] || 0) + 1;
  for (i = 0; i < a.length; i++) { if (n[a[i].d]) n[a[i].d]--; else out.push(a[i]); }
  return out;
}

/**
 * What AE has to draw for a text node, asked from Figma itself on a page clone:
 *  - "…" truncation: the characters Figma actually shows (clone outlines must match the original)
 *  - underline / strike-through: the outline pieces that vanish when the decoration is removed
 * Read-only files can't be cloned: then the old warnings stay.
 */
async function textSource(node) {
  var segs = node.getStyledTextSegments(SEG_FIELDS);
  var src = { segs: segs, outline: geomPaths(node.fillGeometry), deco: [], decoLost: false };
  var decorated = segs.some(isDecorated), truncated = node.textTruncation === 'ENDING';
  if (!decorated && !truncated) return src;
  var c = null;
  try {
    for (var f = 0; f < segs.length; f++) await figma.loadFontAsync(segs[f].fontName);
    if (truncated) {
      var t = await truncatedClone(node);
      if (t) { c = t; src.segs = c.getStyledTextSegments(SEG_FIELDS); src.outline = geomPaths(c.fillGeometry); }
      else if (t === null) warn(node, 'ellipsis truncation not reproduced (read-only file) — full text transferred');
    }
    if (decorated && !c) c = cloneOnPage(node);
    if (decorated && c) {
      var prev = subpaths(c.fillGeometry);
      for (var i = 0; i < src.segs.length; i++) {
        if (!isDecorated(src.segs[i])) continue;
        c.setRangeTextDecoration(src.segs[i].start, src.segs[i].end, 'NONE');
        var cur = subpaths(c.fillGeometry);
        src.deco.push({ seg: i, paths: minusPaths(prev, cur) });
        prev = cur;
      }
      src.outline = geomPaths(c.fillGeometry);
    }
  } catch (e) {
    src = { segs: segs, outline: geomPaths(node.fillGeometry), deco: [], decoLost: decorated };
    if (truncated) warn(node, 'ellipsis truncation not reproduced (' + ((e && e.message) || e) + ') — full text transferred');
    return src;
  } finally { if (c) c.remove(); }
  if (decorated && !c) src.decoLost = true;
  return src;
}

/**
 * A clone showing exactly what the truncated node shows: the longest prefix +
 * "…" that fits the box with truncation off. false: nothing is cut; null: no clone (read-only file).
 */
async function truncatedClone(node) {
  var chars = node.characters, want = JSON.stringify(node.fillGeometry);
  function make(n) {
    var c = cloneOnPage(node);
    if (!c) return null;
    var cut = n;
    while (cut > 0 && /\s/.test(chars.charAt(cut - 1))) cut--;
    c.textTruncation = 'DISABLED';
    if ('maxLines' in c) c.maxLines = null;
    if (cut < chars.length) c.deleteCharacters(cut, chars.length);
    if (n < chars.length) c.insertCharacters(cut, '…');
    return c;
  }
  function fits(n) {
    var c = make(n);
    if (!c) return null;
    try { c.textAutoResize = 'HEIGHT'; return c.height <= node.height + 0.5; } finally { c.remove(); }
  }
  var lo = 0, hi = chars.length;                 // fits(lo) assumed, find the largest n that fits
  var all = fits(hi);
  if (all !== false) return all ? false : null;
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1, r = fits(mid);
    if (r === null) return null;
    if (r) lo = mid; else hi = mid;
  }
  var best = make(lo);
  if (!best) return null;
  best.textAutoResize = 'NONE';
  best.resize(node.width, node.height);
  if (JSON.stringify(best.fillGeometry) !== want) warn(node, 'ellipsis truncation: Figma cuts this text differently than by characters — check the end of the line');
  return best;
}

async function textParts(node, M, o) {
  var w = node.width, h = node.height, segs, src;
  try {
    src = await textSource(node);
    segs = src.segs;
  } catch (e) {
    warn(node, 'could not read the text styles — baked to PNG');
    return 'RASTER';
  }

  var base = { chars: '', box: node.textAutoResize !== 'WIDTH_AND_HEIGHT', align: node.textAlignHorizontal, valign: node.textAlignVertical,
               paraSpacing: node.paragraphSpacing || 0, indent: node.paragraphIndent || 0, outline: src.outline, deco: src.decoLost };
  if (src.decoLost) warn(node, 'underline/strikethrough — read-only file, not transferred');
  var ss = [], paints = [], hasList = false, i, k;
  for (i = 0; i < segs.length; i++) {
    var s = segs[i];
    paints[i] = paintList(s.fills, w, h, node);
    if (paints[i] === 'RASTER') return 'RASTER';
    var ls = s.letterSpacing, lh = s.lineHeight, size = s.fontSize, leading;
    if (lh.unit === 'PIXELS') leading = lh.value;
    else if (lh.unit === 'PERCENT') leading = size * lh.value / 100;
    else leading = await measureAutoLineHeight(s.fontName, size);
    if (s.listOptions && s.listOptions.type && s.listOptions.type !== 'NONE') hasList = true;
    var text = caseOf(s.characters, s.textCase);
    ss.push({ start: base.chars.length, end: base.chars.length + text.length, family: s.fontName.family, style: s.fontName.style, size: size,
              tracking: ls.unit === 'PERCENT' ? ls.value * 10 : (size ? ls.value / size * 1000 : 0),   // AE: 1/1000 em
              leading: leading });
    base.chars += text;
  }
  if (hasList) warn(node, 'bulleted/numbered list — markers are not transferred to AE');

  function segsWith(fn) {           // copy of the styles; fn(i) -> {fill, color, alpha}
    return ss.map(function (s0, j) { var r = fn(j), c = {}; for (var q in s0) c[q] = s0[q]; c.fill = r.fill; c.color = r.color; c.alpha = r.alpha; return c; });
  }
  var simple = true;
  for (i = 0; i < ss.length; i++) {
    for (k = 0; k < paints[i].length; k++) if (paints[i][k].kind !== 'solid') simple = false;
    if (paints[i].length > 1) simple = false;
  }

  var strokes = paintList(node.strokes, w, h, node);
  if (strokes === 'RASTER') return 'RASTER';
  var sw = node.strokeWeight === figma.mixed ? 1 : node.strokeWeight;
  var align = node.strokeAlign;
  var solidStroke = strokes.length === 1 && strokes[0].kind === 'solid';

  // underline / strike-through: Figma's own line shapes over the text, painted like their characters
  var decoLayers = [];
  for (i = 0; i < src.deco.length; i++) {
    var dp = src.deco[i].paths, dl = paints[src.deco[i].seg], drun = [];
    for (k = 0; k <= dl.length && dp.length; k++) {
      if (dl[k] && isVectorPaint(dl[k])) { drun.push({ paths: dp, paint: dl[k] }); continue; }
      if (drun.length) decoLayers.push(nodeShape(node, M, drun, node.name + ' · line'));
      drun = [];
      var DL = dl[k] ? await mattedPaint(node, M, o, dl[k], dp, node.name + ' · line') : null;
      if (DL) decoLayers.push(DL);
    }
  }

  // 1. the common case: one layer, colours per character, AE's own stroke
  if (simple && (!strokes.length || (solidStroke && align !== 'INSIDE'))) {
    var one = textCopy(node, M, base, segsWith(function (j) {
      var p = paints[j][0];
      return p ? { fill: true, color: p.color, alpha: p.opacity } : { fill: false, color: [0, 0, 0], alpha: 100 };
    }), solidStroke ? { color: strokes[0].color, width: align === 'OUTSIDE' ? sw * 2 : sw, overFill: align === 'CENTER' } : null, node.name);
    if (solidStroke && strokes[0].opacity < 100) warn(node, 'text stroke opacity is not transferred');
    return [one].concat(decoLayers);
  }

  // 2. decomposed: fills by paint list, then strokes
  var parts = [], m = Math.ceil(Math.max(w, h, 1));
  var pad = polyPath([[-m, -m], [w + m, -m], [w + m, h + m], [-m, h + m]]);   // covers wider substitute fonts too
  var whiteOnly = function (keep) { return segsWith(function (j) { return { fill: keep(j), color: [1, 1, 1], alpha: 100 }; }); };

  if (strokes.length && align === 'OUTSIDE') await addStroke();  // under the fills, they hide its inner half

  var groupsSeen = {};
  for (i = 0; i < ss.length; i++) {
    var key = JSON.stringify(paints[i]);
    if (groupsSeen[key] || !paints[i].length) continue;
    groupsSeen[key] = true;
    var members = function (j) { return JSON.stringify(paints[j]) === key; };
    var list = paints[i];
    if (list.length === 1 && list[0].kind === 'solid') {
      parts.push(textCopy(node, M, base, segsWith(function (j) {
        return members(j) ? { fill: true, color: list[0].color, alpha: list[0].opacity } : { fill: false, color: [0, 0, 0], alpha: 100 };
      }), null, node.name));
      continue;
    }
    if (list.length === 1 && list[0].fx) {
      var FX = list[0].fx;
      var RT = textCopy(node, M, base, segsWith(function (j) { return { fill: members(j), color: FX.solid || [1, 1, 1], alpha: 100 }; }), null, node.name);
      RT.fx = FX; RT.opacity = list[0].opacity * FX.alpha; RT.blend = list[0].blend;
      parts.push(RT);
      continue;
    }
    // paint layers over the padded text box, matted by a white copy of just these characters
    var run = [];
    for (k = 0; k <= list.length; k++) {
      var P = list[k];
      if (P && isVectorPaint(P)) { run.push({ paths: [{ d: pad, evenOdd: false }], paint: P }); continue; }
      if (run.length) {
        var G = nodeShape(node, M, run, node.name + ' · fill');
        G.matte = { layer: textCopy(node, M, base, whiteOnly(members), null, node.name), mode: 'ALPHA' };
        parts.push(G); run = [];
      }
      if (!P) break;
      var L = P.kind === 'image' ? await imageLayer(node, M, o, P, node.name + ' · image')
            : nodeShape(node, M, P.kind === 'angular' ? angularGroups(P, w, h) : diamondGroups(P, w, h), node.name + ' · gradient');
      if (!L) continue;
      if (P.kind !== 'image') L.blend = P.blend;
      L.matte = { layer: textCopy(node, M, base, whiteOnly(members), null, node.name), mode: 'ALPHA' };
      parts.push(L);
    }
  }

  if (strokes.length && align !== 'OUTSIDE') await addStroke();
  return parts.concat(decoLayers);

  async function addStroke() {
    var width = align === 'CENTER' ? sw : sw * 2;
    var noFill = whiteOnly(function () { return false; });
    for (var q = 0; q < strokes.length; q++) {
      var P2 = strokes[q], L2;
      if (P2.kind === 'solid') {
        L2 = textCopy(node, M, base, noFill, { color: P2.color, width: width, overFill: true }, node.name + ' · stroke');
        L2.opacity = P2.opacity;
      } else if (P2.fx) {
        L2 = textCopy(node, M, base, noFill, { color: P2.fx.solid || [1, 1, 1], width: width, overFill: true }, node.name + ' · stroke');
        L2.fx = P2.fx; L2.opacity = P2.opacity * P2.fx.alpha; L2.blend = P2.blend;
      } else {
        // non-solid stroke: a white stroke-only copy mattes the paint
        L2 = P2.kind === 'image' ? await imageLayer(node, M, o, P2, node.name + ' · stroke')
           : nodeShape(node, M, isVectorPaint(P2) ? [{ paths: [{ d: pad, evenOdd: false }], paint: P2 }]
                                                   : P2.kind === 'angular' ? angularGroups(P2, w, h) : diamondGroups(P2, w, h), node.name + ' · stroke');
        if (!L2) continue;
        L2.matte = { layer: textCopy(node, M, base, noFill, { color: [1, 1, 1], width: width, overFill: true }, node.name + ' · stroke · shape'), mode: 'ALPHA' };
      }
      if (align === 'INSIDE') {
        // AE strokes are centred: double width, then keep only the part inside the glyphs
        if (L2.matte) { warn(node, 'inside text stroke with a gradient/image transferred as a centre stroke'); }
        else L2.matte = { layer: textCopy(node, M, base, whiteOnly(function () { return true; }), null, node.name + ' · stroke · inside'), mode: 'ALPHA' };
      }
      parts.push(L2);
    }
  }
}

/* ------------------------------------------------------------- precomp */

/**
 * Inside of a container: background, children, inner shadows, border on top.
 * A clipping frame whose outline is not its comp's rectangle (rounded corners,
 * comp padded for an outside border) clips the children by a matte of that outline.
 */
async function containerContent(node, innerM, o, layers, w, h, padded) {
  await emitSelf(node, innerM, o, layers, true, 'fills');
  if (node.clipsContent === true && (padded || !plainRect(node))) {
    var kids = [];
    await emitChildren(node.children, innerM, kids, o);
    if (kids.length) layers.push(clipLayer(node, innerM, kids, w, h));
  } else await emitChildren(node.children, innerM, layers, o);
  var inner = liveEffects(node, 'INNER_SHADOW'), fp = geomPaths(node.fillGeometry);
  for (var i = 0; i < inner.length && fp.length; i++) layers.push(innerShadowLayer(node, innerM, inner[i], fp, node.name));
  await emitSelf(node, innerM, o, layers, true, 'strokes');
}

function plainRect(node) {
  if (!('cornerRadius' in node)) return true;
  return node.cornerRadius !== figma.mixed && !node.cornerRadius;
}

/** how far the node's own border reaches outside its box */
function outerStroke(node) {
  var s = node.strokes, any = false;
  if (!s || s === figma.mixed || node.strokeAlign === 'INSIDE') return 0;
  for (var i = 0; i < s.length; i++) if (s[i].visible !== false) any = true;
  if (!any) return 0;
  var sw = node.strokeWeight === figma.mixed
    ? Math.max(node.strokeTopWeight || 0, node.strokeRightWeight || 0, node.strokeBottomWeight || 0, node.strokeLeftWeight || 0)
    : (node.strokeWeight || 0);
  return Math.ceil(node.strokeAlign === 'CENTER' ? sw / 2 : sw);
}

/** the frame's outline in node space: Figma's geometry, else rebuilt from the corner radii */
function clipPaths(node) {
  var g = geomPaths(node.fillGeometry);
  if (g.length) return g;
  var w = node.width, h = node.height, k = 0.5523, cr = node.cornerRadius;
  var r = cr === figma.mixed ? [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] : [cr, cr, cr, cr];
  r = r.map(function (v) { return Math.min(v || 0, w / 2, h / 2); });
  if (node.cornerSmoothing) warn(node, 'corner smoothing of the clip (frame without fill) transferred as a plain radius');
  var d = 'M' + r[0] + ' 0L' + (w - r[1]) + ' 0C' + (w - r[1] + r[1] * k) + ' 0 ' + w + ' ' + (r[1] - r[1] * k) + ' ' + w + ' ' + r[1] +
          'L' + w + ' ' + (h - r[2]) + 'C' + w + ' ' + (h - r[2] + r[2] * k) + ' ' + (w - r[2] + r[2] * k) + ' ' + h + ' ' + (w - r[2]) + ' ' + h +
          'L' + r[3] + ' ' + h + 'C' + (r[3] - r[3] * k) + ' ' + h + ' 0 ' + (h - r[3] + r[3] * k) + ' 0 ' + (h - r[3]) +
          'L0 ' + r[0] + 'C0 ' + (r[0] - r[0] * k) + ' ' + (r[0] - r[0] * k) + ' 0 ' + r[0] + ' 0Z';
  return [{ d: d, evenOdd: false }];
}

/** children of a clipping frame: a precomp the size of the parent comp, matted by the frame outline */
function clipLayer(node, innerM, kids, w, h) {
  return {
    name: node.name + ' · content', type: 'precomp', size: [w, h],
    anchor: [w / 2, h / 2], pos: [w / 2, h / 2], rot: 0, scale: [100, 100],
    opacity: 100, blend: 'NORMAL', effects: [], hidden: false, locked: false,
    comp: { name: node.name + ' · content', w: w, h: h, layers: kids },
    matte: { layer: nodeShape(node, innerM, [{ paths: clipPaths(node), paint: WHITE }], node.name + ' · clip'), mode: 'ALPHA' }
  };
}

async function precompLayer(node, M, o) {
  var clip = node.clipsContent === true;
  var innerM, lm, w, h;

  if (node.blendMode === 'PASS_THROUGH') {
    for (var k = 0; k < node.children.length; k++) {
      if (realBlend(node.children[k].blendMode)) {
        warn(node, 'group became a precomp — the blend mode of "' + node.children[k].name + '" now only blends inside it');
        break;
      }
    }
  }

  var sh = spreadShadows(node);
  if (clip) {
    // comp space = node local space, padded by whatever the frame draws outside its box: border, vector shadows
    var pad = outerStroke(node);
    for (var s = 0; s < sh.length; s++) {
      var e = sh[s];
      pad = Math.max(pad, Math.ceil(Math.abs(e.offset.x) + Math.abs(e.offset.y) + Math.max(0, e.spread || 0) + 2 * e.radius) + 1);
    }
    innerM = mul([1, 0, 0, 1, pad, pad], inv(m32(node.absoluteTransform)));
    w = Math.max(1, Math.round(node.width + 2 * pad));
    h = Math.max(1, Math.round(node.height + 2 * pad));
    lm = mul(M, mul(m32(node.absoluteTransform), [1, 0, 0, 1, -pad, -pad]));
  } else {
    // no clipping: children may overflow, so the precomp is an absolute-aligned
    // box around everything the group renders (including its effects)
    var rb = node.absoluteRenderBounds || node.absoluteBoundingBox;
    if (!rb) return null;
    innerM = [1, 0, 0, 1, -rb.x, -rb.y];
    w = Math.max(1, Math.ceil(rb.width));
    h = Math.max(1, Math.ceil(rb.height));
    lm = mul(M, [1, 0, 0, 1, rb.x, rb.y]);
  }

  var layers = sh.map(function (e) { return shadowLayer(node, innerM, e); });
  await containerContent(node, innerM, o, layers, w, h, clip && pad > 0);
  if (layers.length === sh.length) return null;

  var L = baseLayer(node, xform(node, lm, w, h));
  L.type = 'precomp';
  L.size = [w, h];
  L.comp = { name: node.name, w: w, h: h, layers: layers };
  L.effects = effectsOf(node, L, M, false);
  return L;
}

/**
 * Figma mask: the mask node masks every sibling above it. In AE that is a
 * precomp of those siblings with the mask node as its track matte.
 */
async function maskedLayer(maskNode, content, M, o) {
  var rb = maskNode.absoluteRenderBounds || maskNode.absoluteBoundingBox;
  if (!rb) return null;
  var innerM = [1, 0, 0, 1, -rb.x, -rb.y];          // nothing outside the mask is visible
  var layers = [];
  await emitChildren(content, innerM, layers, o);
  if (!layers.length) return null;

  var w = Math.max(1, Math.ceil(rb.width)), h = Math.max(1, Math.ceil(rb.height));
  var lm = mul(M, [1, 0, 0, 1, rb.x, rb.y]);
  var L = baseLayer(maskNode, xform(maskNode, lm, w, h));
  L.name = maskNode.name + ' · masked';
  L.type = 'precomp';
  L.size = [w, h];
  L.comp = { name: maskNode.name + ' · masked', w: w, h: h, layers: layers };
  L.opacity = 100; L.blend = 'NORMAL'; L.effects = []; L.hidden = false; L.locked = false;

  // the matte itself: exactly one layer
  var mt = [];
  if (maskNode.maskType === 'VECTOR' && 'fillGeometry' in maskNode && maskNode.fillGeometry.length) {
    mt.push(nodeShape(maskNode, M, [{ paths: geomPaths(maskNode.fillGeometry), paint: WHITE }], maskNode.name));
  } else {
    await emitNode(maskNode, M, mt, o);
    if (mt.length && mt[0].type === 'bgblur') mt.shift();
    if (mt.length > 1) {
      // several layers draw the mask: they matte as one precomp
      var inner = [];
      await emitNode(maskNode, innerM, inner, o);
      var P = baseLayer(maskNode, xform(maskNode, lm, w, h));
      P.type = 'precomp'; P.size = [w, h]; P.opacity = 100; P.blend = 'NORMAL'; P.effects = [];
      P.comp = { name: maskNode.name + ' · mask', w: w, h: h, layers: inner };
      mt = [P];
    }
  }
  if (!mt.length) { warn(maskNode, 'could not build the mask — content left unmasked'); return L; }
  mt[0].hidden = false;
  mt[0].name = maskNode.name + ' · mask';
  L.matte = { layer: mt[0], mode: maskNode.maskType === 'LUMINANCE' ? 'LUMA' : 'ALPHA' };
  return L;
}

/* -------------------------------------------------------------- raster */

/** duplicate on the page root at the same absolute place; null for read-only files */
function cloneOnPage(node) {
  try {
    var c = node.clone();
    figma.currentPage.appendChild(c);
    c.relativeTransform = node.absoluteTransform;
    return c;
  } catch (e) { return null; }
}

/**
 * Exact pixels from Figma — only for video/pattern paints and node types with
 * no geometry. Exported from a page-level clone with opacity 1 and normal
 * blending, so the AE layer carries opacity/blend exactly once.
 */
async function rasterLayer(node, M, o, opts) {
  var c = cloneOnPage(node), src = c || node;
  try {
    if (c) {
      c.opacity = 1; c.blendMode = 'NORMAL'; c.visible = true;
      if ('isMask' in c && c.isMask) c.isMask = false;
      if (opts.noEffects) c.effects = [];
      if (opts.noChildren && 'children' in c) {
        if (c.type === 'INSTANCE') { c = c.detachInstance(); src = c; }
        if ('layoutMode' in c && c.layoutMode !== 'NONE') c.layoutMode = 'NONE';   // keep size when emptied
        while (c.children.length) c.children[0].remove();
      }
    } else if (opts.noChildren) {
      warn(node, 'read-only file — a video/pattern background cannot be baked separately, skipped');
      return null;
    }

    var rb = src.absoluteRenderBounds;
    if (!rb || rb.width <= 0 || rb.height <= 0) return null;
    var settings = { format: 'PNG', constraint: { type: 'SCALE', value: o.scale } };
    if (P3) settings.colorProfile = 'SRGB';
    var bytes = await src.exportAsync(settings);

    var s = o.scale;
    var px = pngSize(bytes) || { w: Math.round(rb.width * s), h: Math.round(rb.height * s) };
    // Figma snaps exports to its pixel grid; when the PNG size says so, use the snapped origin
    var x0 = rb.x, y0 = rb.y;
    var fx0 = Math.floor(rb.x * s + 1e-6), fy0 = Math.floor(rb.y * s + 1e-6);
    if (px.w === Math.ceil((rb.x + rb.width) * s - 1e-6) - fx0 && px.w !== Math.round(rb.width * s)) x0 = fx0 / s;
    if (px.h === Math.ceil((rb.y + rb.height) * s - 1e-6) - fy0 && px.h !== Math.round(rb.height * s)) y0 = fy0 / s;

    var w = px.w / s, h = px.h / s;
    var lm = mul(M, [1, 0, 0, 1, x0, y0]);
    var L = baseLayer(node, xform(node, lm, w, h));
    L.type = 'image';
    L.size = [w, h];
    L.png = { b64: b64(bytes), ext: 'png', w: px.w, h: px.h, scale: s };
    L.effects = [];                               // already in the pixels
    if (!c) L.opacity = 100;                      // exported straight from the node: opacity is baked
    return L;
  } catch (e) {
    warn(node, 'PNG export failed: ' + e);
    return null;
  } finally {
    if (c) c.remove();
  }
}

function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  function u32(i) { return (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0; }
  return { w: u32(16), h: u32(20) };
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(bytes) {
  var out = [], i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  var rest = bytes.length - i;
  if (rest === 1) {
    var a = bytes[i] << 16;
    out.push(B64[(a >> 18) & 63] + B64[(a >> 12) & 63] + '==');
  } else if (rest === 2) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(B64[(b >> 18) & 63] + B64[(b >> 12) & 63] + B64[(b >> 6) & 63] + '=');
  }
  return out.join('');
}
