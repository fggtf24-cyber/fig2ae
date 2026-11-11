/**
 * Fig2AE — fonts of an export that After Effects does not have.
 *   check(fonts)   -> which of [{family, style}] AE can't find, even under a slightly different name
 *                     (the same matcher as the importer: ae/fontmatch.jsx)
 *   install(fonts) -> downloads them from Google Fonts (static TTF per style, css2 API) and installs
 *                     them for the current Windows user: %LOCALAPPDATA%\Microsoft\Windows\Fonts + HKCU
 *                     registry, no admin rights. Fonts that are not on Google Fonts (commercial ones)
 *                     come back as "unavailable".
 */
var fs = require('fs'), path = require('path'), os = require('os'), https = require('https'), cp = require('child_process');
var FM = require(path.join(__dirname, 'runtime.js')).fontmatch;

var LIST_CODE = '(function(){var a=app.fonts.allFonts,o=[];for(var i=0;i<a.length;i++)for(var j=0;j<a[i].length;j++){var f=a[i][j];' +
                'o.push(f.familyName+"\\t"+f.styleName+"\\t"+f.postScriptName);}return "FONTS\\n"+o.join("\\n");})()';

/** installed fonts as AE sees them: [{family, style, ps}], or null when AE is busy */
async function installed(evalHost, ms) {
  // AE that never answers (a modal dialog, a dead page) must not hang the Figma plugin: give up after 15 s
  var out = String(await Promise.race([evalHost(LIST_CODE), new Promise(function (r) { setTimeout(function () { r('TIMEOUT'); }, ms || 15000); })]));
  if (out.indexOf('FONTS\n') !== 0) return null;
  return out.slice(6).split('\n').filter(Boolean).map(function (l) { var p = l.split('\t'); return { family: p[0], style: p[1], ps: p[2] }; });
}

/** -> { missing: [{family, style}], renamed: [{family, style, as}] } */
function check(fonts, list) {
  var missing = [], renamed = [], seen = {};
  (fonts || []).forEach(function (f) {
    var k = f.family + '|' + f.style;
    if (seen[k]) return;
    seen[k] = 1;
    var m = FM.match(f.family, f.style, list);
    if (!m) missing.push({ family: f.family, style: f.style });
    else if (!m.exact) renamed.push({ family: f.family, style: f.style, as: m.font.family + ' ' + m.font.style });
  });
  return { missing: missing, renamed: renamed };
}

function get(url, binary) {
  return new Promise(function (resolve, reject) {
    // an old user agent makes Google Fonts answer with plain TrueType files (AE needs TTF/OTF, not woff2)
    https.get(url, { headers: { 'User-Agent': 'Mozilla/4.0 (compatible; Fig2AE)' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(res.headers.location, binary)); }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { var b = Buffer.concat(chunks); resolve({ status: res.statusCode, body: binary ? b : b.toString('utf8') }); });
    }).on('error', reject).setTimeout(30000, function () { this.destroy(new Error('timeout')); });
  });
}

/** which families Google Fonts has (one small css2 request each, answers cached) -> { family: true|false } */
var googleCache = {};
async function onGoogle(families, opts) {
  opts = opts || {};
  var out = {};
  await Promise.all(families.map(async function (fam) {
    if (fam in googleCache) { out[fam] = googleCache[fam]; return; }
    try {
      var r = await (opts.get || get)('https://fonts.googleapis.com/css2?family=' + encodeURIComponent(fam).replace(/%20/g, '+'));
      out[fam] = googleCache[fam] = r.status === 200;
    } catch (e) { out[fam] = null; }                               // offline: unknown, not cached
  }));
  return out;
}

var WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

function userFontsDir() { return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts'); }

/** registers the files for this user and tells running programs (WM_FONTCHANGE) */
function register(files) {
  files.forEach(function (f) {
    cp.execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', f.name + ' (TrueType)', '/t', 'REG_SZ', '/d', f.file, '/f'], { windowsHide: true });
  });
  var ps = 'Add-Type -Namespace F2A -Name Font -MemberDefinition \'[DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern int AddFontResource(string f);' +
           '[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);\';' +
           files.map(function (f) { return '[void][F2A.Font]::AddFontResource(\'' + f.file.replace(/'/g, "''") + '\');'; }).join('') +
           '$r=[IntPtr]::Zero; [void][F2A.Font]::SendMessageTimeout([IntPtr]0xffff, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 3000, [ref]$r)';
  cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
}

/** -> { installed: ["Inter Medium", …], unavailable: ["SF Pro Medium", …], failed: [{font, error}] } */
async function install(fonts, opts) {
  opts = opts || {};
  var res = { installed: [], unavailable: [], failed: [] };
  if (process.platform !== 'win32' && !opts.dir) { res.failed.push({ font: '*', error: 'installing fonts works on Windows only' }); return res; }
  var dir = opts.dir || userFontsDir();
  fs.mkdirSync(dir, { recursive: true });
  var byFamily = {};
  (fonts || []).forEach(function (f) {
    var s = FM.styleInfo(f.style);
    (byFamily[f.family] = byFamily[f.family] || []).push({ font: f, w: s.w, i: s.italic ? 1 : 0 });
  });
  var files = [];
  for (var family in byFamily) {
    var want = byFamily[family], tuples = {};
    want.forEach(function (x) { tuples[x.i + ',' + x.w] = 1; });
    var q = Object.keys(tuples).sort(function (a, b) { var p = a.split(','), r = b.split(','); return (p[0] - r[0]) || (p[1] - r[1]); });
    var url = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family).replace(/%20/g, '+') + ':ital,wght@' + q.join(';');
    var css;
    try { css = await (opts.get || get)(url); } catch (e) { want.forEach(function (x) { res.failed.push({ font: x.font.family + ' ' + x.font.style, error: String(e.message || e) }); }); continue; }
    if (css.status !== 200) { want.forEach(function (x) { res.unavailable.push(x.font.family + ' ' + x.font.style); }); continue; }
    var faces = {}, re = /@font-face\s*{([^}]*)}/g, m;
    while ((m = re.exec(css.body))) {
      var st = /font-style:\s*(\w+)/.exec(m[1]), wt = /font-weight:\s*(\d+)/.exec(m[1]), src = /url\((https:[^)]+\.ttf)\)/.exec(m[1]);
      if (st && wt && src) faces[(st[1] === 'italic' ? 1 : 0) + ',' + wt[1]] = src[1];
    }
    for (var k = 0; k < want.length; k++) {
      var x = want[k], u = faces[x.i + ',' + x.w], label = x.font.family + ' ' + x.font.style;
      if (!u) { res.unavailable.push(label); continue; }
      var name = family + ' ' + (WEIGHT_NAMES[x.w] || x.w) + (x.i ? ' Italic' : '');
      var file = path.join(dir, family.replace(/[^\w-]+/g, '') + '-' + (WEIGHT_NAMES[x.w] || x.w) + (x.i ? 'Italic' : '') + '.ttf');
      try {
        if (!fs.existsSync(file)) {
          var b = await (opts.get || get)(u, true);
          if (b.status !== 200 || b.body.length < 1000) throw new Error('HTTP ' + b.status);
          fs.writeFileSync(file, b.body);
        }
        files.push({ name: name, file: file });
        res.installed.push(label);
      } catch (e) { res.failed.push({ font: label, error: String(e.message || e) }); }
    }
  }
  if (files.length && !opts.dir) {
    try { register(files); } catch (e) { res.failed.push({ font: '*', error: 'could not register the fonts: ' + String(e.message || e) }); }
  }
  return res;
}

module.exports = { installed: installed, check: check, install: install, onGoogle: onGoogle, LIST_CODE: LIST_CODE };
