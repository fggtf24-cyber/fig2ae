/**
 * node test/fonts.test.js
 * ae/fontmatch.jsx (the same font under a slightly different name) and cep/fonts.js
 * (which fonts AE lacks; installing them from Google Fonts — network faked).
 */
var assert = require('assert');
var fs = require('fs'), os = require('os'), path = require('path');
require('../build.js');                       // runtime.js must be current (figma.test checks that too)
var FM = require('../cep/runtime.js').fontmatch;
var fonts = require('../cep/fonts.js');

var installed = [
  { family: 'Bebas Neue Pro', style: 'Book', ps: 'BebasNeuePro-Book' },
  { family: 'Bebas Neue Pro', style: 'Bold', ps: 'BebasNeuePro-Bold' },
  { family: 'Inter', style: 'Regular', ps: 'Inter-Regular' },
  { family: 'Inter', style: 'Semi Bold', ps: 'Inter-SemiBold' },
  { family: 'Inter', style: 'Bold Italic', ps: 'Inter-BoldItalic' },
  { family: 'Arial', style: 'Regular', ps: 'ArialMT' },
  { family: 'Arial Black', style: 'Regular', ps: 'Arial-Black' },
  { family: 'Montserrat', style: 'Medium', ps: 'Montserrat-Medium' },
  { family: 'TT Norms', style: 'Regular', ps: 'TTNorms-Regular' }
];
function m(f, s) { var r = FM.match(f, s, installed); return r ? r.font.family + ' / ' + r.font.style : null; }

// the user's case: "Bebas Neue" in Figma, installed under another name
assert.strictEqual(m('Bebas Neue', 'Regular'), 'Bebas Neue Pro / Book');
assert.strictEqual(m('BebasNeue', 'Bold'), 'Bebas Neue Pro / Bold');
assert.strictEqual(m('Bebas', 'Regular'), 'Bebas Neue Pro / Book');
// exact names stay exact, styles written differently match
assert.ok(FM.match('Inter', 'Regular', installed).exact);
assert.strictEqual(m('Inter', 'SemiBold'), 'Inter / Semi Bold');
assert.strictEqual(m('Inter', 'Bold Italic'), 'Inter / Bold Italic');
assert.strictEqual(m('Inter', 'Medium'), 'Inter / Regular', 'ближайший вес, не курсив');
// different designs are not mixed up
assert.strictEqual(m('Arial', 'Regular'), 'Arial / Regular');
assert.strictEqual(m('Roboto', 'Regular'), null);
assert.strictEqual(m('TT Commons', 'Regular'), null, 'TT Commons — не TT Norms');
assert.strictEqual(m('Mont', 'Regular'), null, 'слишком короткое начало не считается');
installed.push({ family: 'Rubik', style: 'Regular', ps: 'Rubik-Regular' }, { family: 'Bebas Neue Cyrillic', style: 'Regular', ps: 'BebasNeueCyrillic' });
assert.strictEqual(m('Rubik Doodle Shadow', 'Regular'), null, 'другой дизайн с тем же первым словом — не тот шрифт');
assert.strictEqual(m('Bebas Neue Cyrillic', 'Regular'), 'Bebas Neue Cyrillic / Regular');
installed.splice(-2, 2);

// check(): missing vs installed under another name
var c = fonts.check([{ family: 'Bebas Neue', style: 'Regular' }, { family: 'Roboto', style: 'Medium' }, { family: 'Inter', style: 'Regular' }], installed);
assert.deepStrictEqual(c.missing, [{ family: 'Roboto', style: 'Medium' }]);
assert.strictEqual(c.renamed.length, 1); assert.strictEqual(c.renamed[0].as, 'Bebas Neue Pro Book');

// install(): one css2 request per family, static TTF per style, unknown families "unavailable"
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-fonts-')), asked = [];
var fakeGet = function (url, binary) {
  asked.push(url);
  if (/fonts\.googleapis\.com/.test(url)) {
    if (/family=Roboto:/.test(url)) {
      return Promise.resolve({ status: 200, body: "@font-face {\n  font-family: 'Roboto';\n  font-style: normal;\n  font-weight: 500;\n  src: url(https://fonts.gstatic.com/s/roboto/a.ttf) format('truetype');\n}\n" +
                                                 "@font-face {\n  font-family: 'Roboto';\n  font-style: italic;\n  font-weight: 700;\n  src: url(https://fonts.gstatic.com/s/roboto/b.ttf) format('truetype');\n}\n" });
    }
    return Promise.resolve({ status: 400, body: '<html>' });
  }
  return Promise.resolve({ status: 200, body: Buffer.alloc(5000, 1) });
};
fonts.install([{ family: 'Roboto', style: 'Medium' }, { family: 'Roboto', style: 'Bold Italic' }, { family: 'SF Pro', style: 'Regular' }], { dir: dir, get: fakeGet }).then(function (r) {
  assert.deepStrictEqual(r.installed, ['Roboto Medium', 'Roboto Bold Italic']);
  assert.deepStrictEqual(r.unavailable, ['SF Pro Regular']);
  assert.deepStrictEqual(r.failed, []);
  assert.ok(fs.existsSync(path.join(dir, 'Roboto-Medium.ttf')) && fs.existsSync(path.join(dir, 'Roboto-BoldItalic.ttf')));
  assert.ok(asked.some(function (u) { return /family=Roboto:ital,wght@0,500;1,700$/.test(u); }), asked.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('fonts: all checks passed');
}).catch(function (e) { console.error(e); process.exit(1); });
