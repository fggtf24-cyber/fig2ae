/**
 * geom.jsx - pure geometry helpers (no AE API here).
 * Shared by Fig2AE.jsx (via #include) and test/geom.test.js (via require in node).
 */
var F2A_GEOM = (function () {
    var EPS = 1e-6;

    /* ---------- SVG path -> bezier subpaths ---------------------------------
     * Returns [{v:[[x,y]..], i:[[dx,dy]..], o:[[dx,dy]..], closed:Boolean}]
     * i/o are tangents RELATIVE to their vertex, exactly like AE's Shape object.
     * Uses a char scanner (not a token regex) so arc flags written without
     * separators ("a1 1 0 011 1") still parse correctly.
     */
    function parsePath(d) {
        var i = 0, n = d.length;
        var subs = [], cur = null;
        var px = 0, py = 0;               // current point
        var sx = 0, sy = 0;               // subpath start
        var lastCx = null, lastCy = null; // last cubic control (for S)
        var lastQx = null, lastQy = null; // last quad control (for T)
        var lastCmd = 'M';

        function isWS(c) { return c === ' ' || c === ',' || c === '\n' || c === '\r' || c === '\t'; }
        function skip() { while (i < n && isWS(d.charAt(i))) i++; }
        function isDigit(c) { return c >= '0' && c <= '9'; }
        function hasNum() {
            skip();
            if (i >= n) return false;
            var c = d.charAt(i);
            return isDigit(c) || c === '-' || c === '+' || c === '.';
        }
        function num() {
            skip();
            var s = i, c = d.charAt(i);
            if (c === '-' || c === '+') i++;
            while (i < n && isDigit(d.charAt(i))) i++;
            if (d.charAt(i) === '.') { i++; while (i < n && isDigit(d.charAt(i))) i++; }
            c = d.charAt(i);
            if (c === 'e' || c === 'E') {
                i++;
                c = d.charAt(i);
                if (c === '-' || c === '+') i++;
                while (i < n && isDigit(d.charAt(i))) i++;
            }
            return parseFloat(d.substring(s, i));
        }
        function flag() { skip(); return d.charAt(i++) === '1'; }

        function open(x, y) {
            finish(false);
            cur = { v: [[x, y]], i: [[0, 0]], o: [[0, 0]], closed: false };
            subs.push(cur);
            sx = x; sy = y;
        }
        function lineTo(x, y) {
            if (!cur) open(px, py);
            if (Math.abs(x - px) < EPS && Math.abs(y - py) < EPS) return; // drop zero-length segment
            cur.v.push([x, y]); cur.i.push([0, 0]); cur.o.push([0, 0]);
        }
        function curveTo(c1x, c1y, c2x, c2y, x, y) {
            if (!cur) open(px, py);
            var last = cur.v.length - 1;
            cur.o[last] = [c1x - cur.v[last][0], c1y - cur.v[last][1]];
            cur.v.push([x, y]); cur.i.push([c2x - x, c2y - y]); cur.o.push([0, 0]);
        }
        function finish(closed) {
            if (!cur) return;
            if (closed) {
                cur.closed = true;
                var L = cur.v.length - 1;
                // Fold a duplicated closing vertex into the first one. Without this
                // AE ends up with a stray extra point / kink at the seam.
                if (L > 0 && Math.abs(cur.v[L][0] - cur.v[0][0]) < 1e-4 && Math.abs(cur.v[L][1] - cur.v[0][1]) < 1e-4) {
                    cur.i[0] = cur.i[L];
                    cur.v.pop(); cur.i.pop(); cur.o.pop();
                }
            }
            cur = null;
        }

        while (i < n) {
            skip();
            if (i >= n) break;
            var cmd = d.charAt(i);
            if (isDigit(cmd) || cmd === '-' || cmd === '+' || cmd === '.') {
                cmd = lastCmd;                       // implicit repeat of previous command
                if (cmd === 'M') cmd = 'L';
                if (cmd === 'm') cmd = 'l';
            } else { i++; }
            lastCmd = cmd;
            var rel = cmd >= 'a' && cmd <= 'z';
            var C = cmd.toUpperCase();
            var ox = rel ? px : 0, oy = rel ? py : 0;
            var x, y, x1, y1, x2, y2;

            switch (C) {
                case 'M':
                    x = num() + ox; y = num() + oy;
                    open(x, y); px = x; py = y;
                    while (hasNum()) {                // extra pairs are implicit lineTo
                        ox = rel ? px : 0; oy = rel ? py : 0;
                        x = num() + ox; y = num() + oy;
                        lineTo(x, y); px = x; py = y;
                    }
                    lastCx = lastQx = null;
                    break;
                case 'L':
                    do {
                        ox = rel ? px : 0; oy = rel ? py : 0;
                        x = num() + ox; y = num() + oy;
                        lineTo(x, y); px = x; py = y;
                    } while (hasNum());
                    lastCx = lastQx = null;
                    break;
                case 'H':
                    do { x = num() + (rel ? px : 0); lineTo(x, py); px = x; } while (hasNum());
                    lastCx = lastQx = null;
                    break;
                case 'V':
                    do { y = num() + (rel ? py : 0); lineTo(px, y); py = y; } while (hasNum());
                    lastCx = lastQx = null;
                    break;
                case 'C':
                    do {
                        ox = rel ? px : 0; oy = rel ? py : 0;
                        x1 = num() + ox; y1 = num() + oy;
                        x2 = num() + ox; y2 = num() + oy;
                        x = num() + ox; y = num() + oy;
                        curveTo(x1, y1, x2, y2, x, y);
                        px = x; py = y; lastCx = x2; lastCy = y2; lastQx = null;
                    } while (hasNum());
                    break;
                case 'S':
                    do {
                        ox = rel ? px : 0; oy = rel ? py : 0;
                        x1 = lastCx === null ? px : 2 * px - lastCx;
                        y1 = lastCx === null ? py : 2 * py - lastCy;
                        x2 = num() + ox; y2 = num() + oy;
                        x = num() + ox; y = num() + oy;
                        curveTo(x1, y1, x2, y2, x, y);
                        px = x; py = y; lastCx = x2; lastCy = y2; lastQx = null;
                    } while (hasNum());
                    break;
                case 'Q':
                    do {
                        ox = rel ? px : 0; oy = rel ? py : 0;
                        var qx = num() + ox, qy = num() + oy;
                        x = num() + ox; y = num() + oy;
                        curveTo(px + 2 / 3 * (qx - px), py + 2 / 3 * (qy - py),
                                x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
                        px = x; py = y; lastQx = qx; lastQy = qy; lastCx = null;
                    } while (hasNum());
                    break;
                case 'T':
                    do {
                        ox = rel ? px : 0; oy = rel ? py : 0;
                        var tx = lastQx === null ? px : 2 * px - lastQx;
                        var ty = lastQx === null ? py : 2 * py - lastQy;
                        x = num() + ox; y = num() + oy;
                        curveTo(px + 2 / 3 * (tx - px), py + 2 / 3 * (ty - py),
                                x + 2 / 3 * (tx - x), y + 2 / 3 * (ty - y), x, y);
                        px = x; py = y; lastQx = tx; lastQy = ty; lastCx = null;
                    } while (hasNum());
                    break;
                case 'A':
                    do {
                        ox = rel ? px : 0; oy = rel ? py : 0;
                        var rx = num(), ry = num(), rot = num();
                        var laf = flag(), sf = flag();
                        x = num() + ox; y = num() + oy;
                        var segs = arcToCubic(px, py, rx, ry, rot, laf, sf, x, y);
                        for (var k = 0; k < segs.length; k++) {
                            curveTo(segs[k][0], segs[k][1], segs[k][2], segs[k][3], segs[k][4], segs[k][5]);
                        }
                        px = x; py = y; lastCx = lastQx = null;
                    } while (hasNum());
                    break;
                case 'Z':
                    finish(true);
                    px = sx; py = sy;
                    lastCx = lastQx = null;
                    break;
                default:
                    return collect(subs); // unknown command: stop rather than emit garbage
            }
        }
        finish(false);
        return collect(subs);
    }

    function collect(subs) {
        var out = [];
        for (var s = 0; s < subs.length; s++) if (subs[s].v.length > 1) out.push(subs[s]);
        return out;
    }

    /* endpoint-parameterised arc -> cubic segments (SVG spec, impl. notes F.6) */
    function arcToCubic(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
        if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
        rx = Math.abs(rx); ry = Math.abs(ry);
        var phi = phiDeg * Math.PI / 180;
        var cosP = Math.cos(phi), sinP = Math.sin(phi);
        var dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
        var x1p = cosP * dx2 + sinP * dy2;
        var y1p = -sinP * dx2 + cosP * dy2;

        var lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lam > 1) { var sc = Math.sqrt(lam); rx *= sc; ry *= sc; }

        var sign = (fa === fs) ? -1 : 1;
        var nm = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        var dn = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        var co = sign * Math.sqrt(Math.max(0, nm / dn));
        var cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
        var cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
        var cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

        function ang(ux, uy, vx, vy) {
            var a = Math.atan2(uy, ux), b = Math.atan2(vy, vx), r = b - a;
            if (r > Math.PI) r -= 2 * Math.PI;
            if (r < -Math.PI) r += 2 * Math.PI;
            return r;
        }
        var th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        var dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!fs && dth > 0) dth -= 2 * Math.PI;
        if (fs && dth < 0) dth += 2 * Math.PI;

        var segs = Math.ceil(Math.abs(dth) / (Math.PI / 2));
        var out = [], delta = dth / segs;
        var t = 4 / 3 * Math.tan(delta / 4);
        var th = th1;
        var cosT = Math.cos(th), sinT = Math.sin(th);
        var ex = cosP * rx * cosT - sinP * ry * sinT + cx;
        var ey = sinP * rx * cosT + cosP * ry * sinT + cy;
        for (var k = 0; k < segs; k++) {
            var dxdt = -(cosP * rx * sinT + sinP * ry * cosT);
            var dydt = -(sinP * rx * sinT - cosP * ry * cosT);
            var c1x = ex + t * dxdt, c1y = ey + t * dydt;
            th += delta;
            cosT = Math.cos(th); sinT = Math.sin(th);
            var nx = cosP * rx * cosT - sinP * ry * sinT + cx;
            var ny = sinP * rx * cosT + cosP * ry * sinT + cy;
            var ndxdt = -(cosP * rx * sinT + sinP * ry * cosT);
            var ndydt = -(sinP * rx * sinT - cosP * ry * cosT);
            out.push([c1x, c1y, nx - t * ndxdt, ny - t * ndydt, nx, ny]);
            ex = nx; ey = ny;
        }
        return out;
    }

    /* ---------- 2x3 affine matrices: [a,b,c,d,tx,ty]   x' = a*x + c*y + tx */
    function mul(m, k) {
        return [
            m[0] * k[0] + m[2] * k[1],
            m[1] * k[0] + m[3] * k[1],
            m[0] * k[2] + m[2] * k[3],
            m[1] * k[2] + m[3] * k[3],
            m[0] * k[4] + m[2] * k[5] + m[4],
            m[1] * k[4] + m[3] * k[5] + m[5]
        ];
    }
    function inv(m) {
        var det = m[0] * m[3] - m[1] * m[2];
        if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
        return [
            m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
            (m[2] * m[5] - m[3] * m[4]) / det,
            (m[1] * m[4] - m[0] * m[5]) / det
        ];
    }
    function apply(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }

    /* QR decomposition (CSS transforms spec). rot in degrees, shear unitless. */
    function decompose(m) {
        var a = m[0], b = m[1], c = m[2], d = m[3];
        var sx = Math.sqrt(a * a + b * b);
        if (sx > 0) { a /= sx; b /= sx; }
        var shear = a * c + b * d;
        c -= a * shear; d -= b * shear;
        var sy = Math.sqrt(c * c + d * d);
        if (sy > 0) { c /= sy; d /= sy; shear /= sy; }
        if (a * d - b * c < 0) { a = -a; b = -b; sx = -sx; }
        return { tx: m[4], ty: m[5], rot: Math.atan2(b, a) * 180 / Math.PI, sx: sx, sy: sy, shear: shear };
    }

    /* ---------- exact bounds of bezier subpaths (curve extrema, not control hull) */
    function bounds(subs) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        function add(x, y) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        function ext(p0, p1, p2, p3, axis) {
            // B'(t)/3 = a t^2 + b t + c
            var a = p3 - 3 * p2 + 3 * p1 - p0, b = 2 * (p2 - 2 * p1 + p0), c = p1 - p0, ts = [];
            if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) ts.push(-c / b); }
            else {
                var disc = b * b - 4 * a * c;
                if (disc >= 0) { var q = Math.sqrt(disc); ts.push((-b + q) / (2 * a), (-b - q) / (2 * a)); }
            }
            var out = [];
            for (var k = 0; k < ts.length; k++) {
                var t = ts[k], u = 1 - t;
                if (t > 0 && t < 1) out.push(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
            }
            return out;
        }
        for (var s = 0; s < subs.length; s++) {
            var S = subs[s], n = S.v.length, segs = S.closed ? n : n - 1;
            for (var k = 0; k < n; k++) add(S.v[k][0], S.v[k][1]);
            for (var j = 0; j < segs; j++) {
                var A = S.v[j], B = S.v[(j + 1) % n];
                var c1 = [A[0] + S.o[j][0], A[1] + S.o[j][1]];
                var c2 = [B[0] + S.i[(j + 1) % n][0], B[1] + S.i[(j + 1) % n][1]];
                var ex = ext(A[0], c1[0], c2[0], B[0]), ey = ext(A[1], c1[1], c2[1], B[1]), e;
                // pair each extremum with an already-included coordinate of the other axis
                for (e = 0; e < ex.length; e++) add(ex[e], A[1]);
                for (e = 0; e < ey.length; e++) add(A[0], ey[e]);
            }
        }
        if (x0 === Infinity) return null;
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /* apply an affine matrix to subpaths: vertices fully, tangents by the linear part */
    function transformSubs(subs, m) {
        var out = [];
        for (var s = 0; s < subs.length; s++) {
            var S = subs[s], T = { v: [], i: [], o: [], closed: S.closed };
            for (var k = 0; k < S.v.length; k++) {
                T.v.push(apply(m, S.v[k]));
                T.i.push([m[0] * S.i[k][0] + m[2] * S.i[k][1], m[1] * S.i[k][0] + m[3] * S.i[k][1]]);
                T.o.push([m[0] * S.o[k][0] + m[2] * S.o[k][1], m[1] * S.o[k][0] + m[3] * S.o[k][1]]);
            }
            out.push(T);
        }
        return out;
    }

    /**
     * 2x2 linear part [a,b,c,d] = R(rot) * diag(s1,s2) * R(phi).
     * s1 >= |s2|; a negative s2 encodes a mirror. Used for elliptical radial
     * gradients, where R(phi) is invisible (a circle is rotation-invariant).
     */
    function svd2(m) {
        var A = m[0], B = m[2], C = m[1], D = m[3];   // [[A,B],[C,D]]
        var E = (A + D) / 2, F = (A - D) / 2, G = (C + B) / 2, H = (C - B) / 2;
        var Q = Math.sqrt(E * E + H * H), R = Math.sqrt(F * F + G * G);
        var a1 = Math.atan2(G, F), a2 = Math.atan2(H, E);
        return { s1: Q + R, s2: Q - R, rot: (a2 + a1) / 2 * 180 / Math.PI, phi: (a2 - a1) / 2 * 180 / Math.PI };
    }

    /* ---------- After Effects gradient preset (.ffx) -------------------------
     * Gradient colours of shape layers cannot be set by script (Adobe: property
     * type NO_VALUE). They can be applied as an animation preset. The 840-byte
     * header below (RIFX chunks + property path RootVectors>Group>Vectors>G-Fill>
     * Colors) is taken from AEUX (Apache-2.0, github.com/google/AEUX). We emit
     * the XML ramp ourselves and recompute every enclosing chunk size, so any
     * number of stops and any values are valid (AEUX's fixed-length templates
     * break on values outside 0..1 and cap at 8 stops).
     */
    var GRAD_PREFIX_B64 =
        'UklGWAAACmBGYUZYaGVhZAAAABAAAAADAAAAVwAAAAEAAAAATElTVAAACjxiZXNjYmVzbwAAADgAAAABAAAAAQAAAAAAAGAAABgAAAAAAAQAAQABB4AEOD/wAAAAAAAAP/AAAAAAAAAAAAAA/////0xJU1QAAAGEdGRzcHRkb3QAAAAE/////3RkcGwAAAAEAAAABUxJU1QAAABAdGRzaXRkaXgAAAAE/////3RkbW4AAAAoQURCRSBSb290IFZlY3RvcnMgR3JvdXAAAAAAAAAAAAAAAAAAAAAAAExJU1QAAABAdGRzaXRkaXgAAAAEAAAAAHRkbW4AAAAoQURCRSBWZWN0b3IgR3JvdXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAExJU1QAAABAdGRzaXRkaXgAAAAE/////3RkbW4AAAAoQURCRSBWZWN0b3JzIEdyb3VwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAExJU1QAAABAdGRzaXRkaXgAAAAEAAAAAnRkbW4AAAAoQURCRSBWZWN0b3IgR3JhcGhpYyAtIEctRmlsbAAAAAAAAAAAAAAAAExJU1QAAABAdGRzaXRkaXgAAAAE/////3RkbW4AAAAoQURCRSBWZWN0b3IgR3JhZCBDb2xvcnMAAAAAAAAAAAAAAAAAAAAAAHRkc24AAAAHQ29sb3JzAABMSVNUAAAAZHRkc3B0ZG90AAAABP////90ZHBsAAAABAAAAAFMSVNUAAAAQHRkc2l0ZGl4AAAABP////90ZG1uAAAAKEFEQkUgRW5kIG9mIHBhdGggc2VudGluZWwAAAAAAAAAAAAAAAAAAABMSVNUAAAH6EdDc3RMSVNUAAAAsHRkYnN0ZHNiAAAABAAAAAF0ZHNuAAAAB0NvbG9ycwAAdGRiNAAAAHzbmQABAAcAAP////8AAGAAPxo24uscQy0/8AAAAAAAAD/wAAAAAAAAP/AAAAAAAAA/8AAAAAAAAAABAAgAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY2RhdAAAAAQAAAAATElTVAAAByRHQ2t5';
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    var B64_IDX = (function () { var t = {}; for (var k = 0; k < 64; k++) t[B64.charAt(k)] = k; return t; })();

    /* slow path only (the importer prefers the OS decoder): table lookup, bytes flushed in chunks */
    function b64decode(s) {
        s = s.replace(/[^A-Za-z0-9\+\/]/g, '');
        var n = s.length, parts = [], buf = [], i = 0;
        while (i < n) {
            var e1 = B64_IDX[s.charAt(i)], e2 = B64_IDX[s.charAt(i + 1)];
            var e3 = i + 2 < n ? B64_IDX[s.charAt(i + 2)] : -1, e4 = i + 3 < n ? B64_IDX[s.charAt(i + 3)] : -1;
            i += 4;
            buf.push((e1 << 2) | (e2 >> 4));
            if (e3 >= 0) buf.push(((e2 & 15) << 4) | (e3 >> 2));
            if (e4 >= 0) buf.push(((e3 & 3) << 6) | e4);
            if (buf.length >= 4096) { parts.push(String.fromCharCode.apply(null, buf)); buf = []; }
        }
        parts.push(String.fromCharCode.apply(null, buf));
        return parts.join('');
    }

    function u32(n) { return String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
    function putU32(s, at, n) { return s.substring(0, at) + u32(n) + s.substring(at + 4); }
    function fl(v) { var s = (Math.round(v * 1e6) / 1e6).toString(); return '<float>' + s + '</float>'; }

    function gradientXml(stops) {
        var L = ["<?xml version='1.0'?>", "<prop.map version='4'>", '<prop.list>', '<prop.pair>',
                 '<key>Gradient Color Data</key>', '<prop.list>'];
        function section(title, key, vals) {
            L.push('<prop.pair>', '<key>' + title + '</key>', '<prop.list>', '<prop.pair>', '<key>Stops List</key>', '<prop.list>');
            for (var k = 0; k < stops.length; k++) {
                L.push('<prop.pair>', '<key>Stop-' + k + '</key>', '<prop.list>', '<prop.pair>', '<key>' + key + '</key>',
                       '<array>', '<array.type><float/></array.type>');
                var v = vals(stops[k]);
                for (var j = 0; j < v.length; j++) L.push(fl(v[j]));
                L.push('</array>', '</prop.pair>', '</prop.list>', '</prop.pair>');
            }
            L.push('</prop.list>', '</prop.pair>', '<prop.pair>', '<key>Stops Size</key>',
                   "<int type='unsigned' size='32'>" + stops.length + '</int>', '</prop.pair>', '</prop.list>', '</prop.pair>');
        }
        // midpoint 0.5 = plain linear interpolation, like Figma
        section('Alpha Stops', 'Stops Alpha', function (s) { return [s.pos, 0.5, s.a]; });
        section('Color Stops', 'Stops Color', function (s) { return [s.pos, 0.5, s.color[0], s.color[1], s.color[2], 1]; });
        L.push('</prop.list>', '</prop.pair>', '<prop.pair>', '<key>Gradient Colors</key>', '<string>1.0</string>',
               '</prop.pair>', '</prop.list>', '</prop.map>');
        return L.join('\n') + '\n';
    }

    /**
     * Binary .ffx (as a byte string) that sets the colours of the G-Fill at
     * 0-based (groupIndex, itemIndex) under the layer's Contents.
     */
    function gradientFfx(stops, groupIndex, itemIndex) {
        var s = b64decode(GRAD_PREFIX_B64);              // 840 bytes, ends right before the Utf8 chunk
        s = putU32(s, 240, groupIndex);                  // tdix of "ADBE Vector Group"
        s = putU32(s, 384, itemIndex);                   // tdix of "ADBE Vector Graphic - G-Fill"
        var xml = gradientXml(stops);
        var body = 'Utf8' + u32(xml.length) + xml + (xml.length & 1 ? '\x00' : '');
        var total = s.length + body.length;
        s = putU32(s, 4, total - 8);                     // RIFX
        s = putU32(s, 40, total - 44);                   // LIST besc
        s = putU32(s, 636, total - 640);                 // LIST GCst
        s = putU32(s, 832, total - 836);                 // LIST GCky
        return s + body;
    }

    /**
     * sRGB-encoded colour -> the same colour encoded with a pure power curve
     * (e.g. AE working space "Rec.709 Gamma 2.4": sRGB/709 primaries, gamma 2.4).
     */
    /** a path as one POSIX shell word: inside double quotes $(...) and backticks would still run */
    function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

    function srgbToGamma(c, gamma) {
        var out = [];
        for (var k = 0; k < 3; k++) {
            var v = c[k], lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            out.push(Math.pow(Math.max(0, lin), 1 / gamma));
        }
        return out;
    }

    return {
        srgbToGamma: srgbToGamma,
        shellQuote: shellQuote,
        parsePath: parsePath, arcToCubic: arcToCubic, mul: mul, inv: inv, apply: apply, decompose: decompose,
        bounds: bounds, transformSubs: transformSubs, svd2: svd2,
        b64decode: b64decode, gradientXml: gradientXml, gradientFfx: gradientFfx
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = F2A_GEOM; // node test only
