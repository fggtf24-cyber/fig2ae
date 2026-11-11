/**
 * Fig2AE — finding the installed font for a Figma font when the names differ a little
 * ("Bebas Neue" in Figma, "BebasNeue" / "Bebas Neue Pro" / "Bebas" in the system;
 * style "Regular" in Figma, "Book" in the font file). ES3: runs in ExtendScript (the importer)
 * and in node (cep/server.js checks which fonts of an export are missing before it is sent).
 *
 * F2A_FONTMATCH.match(family, style, fonts) -> { font, score, exact } | null
 *   fonts: [{ family, style, ps }]   (ps = PostScript name)
 */
var F2A_FONTMATCH = (function () {
    function words(s) {
        return String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/^\s+|\s+$/g, '');
    }
    function key(s) { return words(s).replace(/ /g, ''); }

    // words that only mark a release / format of the same design
    // ("Bebas" = "Bebas Neue Cyrillic"); any other extra word is another design ("Rubik Doodle Shadow" is not "Rubik")
    var NOISE = { pro: 1, std: 1, standard: 1, display: 1, variable: 1, vf: 1, ot: 1, otf: 1, tt: 1, ttf: 1, web: 1, regular: 1, font: 1, fonts: 1, family: 1,
                  neue: 1, 'new': 1, cyrillic: 1, cyr: 1, latin: 1, greek: 1, lt: 1, mt: 1, ms: 1, w1g: 1 };
    function core(s) {
        var w = words(s).split(' '), out = [];
        for (var i = 0; i < w.length; i++) if (w[i] && !NOISE[w[i]]) out.push(w[i]);
        return out.join('');
    }

    var WEIGHTS = [['extralight', 200], ['ultralight', 200], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800],
                   ['hairline', 100], ['thin', 100], ['light', 300], ['medium', 500], ['bold', 700], ['heavy', 800], ['black', 900],
                   ['book', 400], ['regular', 400], ['normal', 400], ['roman', 400], ['plain', 400]];
    function styleInfo(s) {
        var k = key(s), w = 400;
        for (var i = 0; i < WEIGHTS.length; i++) if (k.indexOf(WEIGHTS[i][0]) >= 0) { w = WEIGHTS[i][1]; break; }
        return { w: w, italic: /italic|oblique/.test(k), narrow: /condensed|narrow|compressed/.test(k), wide: /expanded|extended|wide/.test(k) };
    }

    function familyScore(F, f, ps) {
        var a = key(F), b = key(f);
        if (!a || !b) return 0;
        if (a === b) return 100;
        var p = key(String(ps || '').split('-')[0]);
        if (p && p === a) return 92;
        // the same name once the release marks are dropped ("Bebas Neue Pro" = "Bebas"); whole words only:
        // "Mont" is not "Montserrat"
        var ca = core(F), cb = core(f);
        if (ca.length >= 3 && ca === cb) return 85 - Math.min(10, Math.abs(words(F).split(' ').length - words(f).split(' ').length) * 3);
        return 0;
    }
    function styleScore(S, s) {
        if (key(S) === key(s)) return 40;
        var x = styleInfo(S), y = styleInfo(s);
        return 30 - Math.abs(x.w - y.w) / 100 * 8 - (x.italic !== y.italic ? 16 : 0) - (x.narrow !== y.narrow ? 6 : 0) - (x.wide !== y.wide ? 6 : 0);
    }

    function match(family, style, fonts) {
        var best = null, bestScore = -1e9;
        for (var i = 0; i < fonts.length; i++) {
            var f = fonts[i], fs = familyScore(family, f.family, f.ps);
            if (fs < 60) continue;
            var sc = fs + styleScore(style, f.style);
            if (sc > bestScore) { bestScore = sc; best = f; }
        }
        if (!best) return null;
        return { font: best, score: bestScore, exact: key(family) === key(best.family) && key(style) === key(best.style) };
    }

    return { match: match, styleInfo: styleInfo, key: key };
})();
