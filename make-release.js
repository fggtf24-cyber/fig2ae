/**
 * node make-release.js            -> Fig2AE.zip + version.txt in the repo root
 * node make-release.js bump 0.4.1 -> writes the version everywhere it lives, then builds
 *
 * Publishing (same scheme as VoiceType): commit Fig2AE.zip + version.txt and push to main.
 * The site links to github.com/brlk33/fig2ae/raw/main/Fig2AE.zip; every installed Fig2AE
 * sees the new version.txt and updates itself (cep/updater.js).
 */
var fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
var build = require('./build.js');
var ROOT = __dirname, DIST = path.join(ROOT, 'dist');

var FILES = {                                     // file -> regexp whose group 1 is the version
  'package.json': /"version": "([\d.]+)"/,
  'cep/server.js': /var VERSION = '([\d.]+)'/,
  'cep/CSXS/manifest.xml': /ExtensionBundleVersion="([\d.]+)"/,
  'figma-plugin/ui.html': /<span>v([\d.]+)<\/span>/,
  'installer/Setup.cs': /Version = "([\d.]+)"/
};
function version() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }

if (process.argv[2] === 'bump') {
  var v = process.argv[3];
  if (!/^\d+\.\d+\.\d+$/.test(v || '')) { console.error('usage: node make-release.js bump 1.2.3'); process.exit(1); }
  Object.keys(FILES).forEach(function (f) {
    var p = path.join(ROOT, f), s = fs.readFileSync(p, 'utf8');
    s = s.replace(new RegExp(FILES[f].source, 'g'), function (m, old) { return m.replace(old, v); });
    if (f === 'cep/CSXS/manifest.xml') s = s.replace(/(Extension Id="com\.fig2ae\.\w+" Version=")[\d.]+/g, '$1' + v);
    fs.writeFileSync(p, s);
  });
  console.log('version -> ' + v);
}

var ver = version();
Object.keys(FILES).forEach(function (f) {
  var m = FILES[f].exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  if (!m || m[1] !== ver) { console.error(f + ': version ' + (m && m[1]) + ' != package.json ' + ver + ' (node make-release.js bump ' + ver + ')'); process.exit(1); }
});

fs.writeFileSync(build.UI, build.uiHtml());
fs.writeFileSync(build.CEP_RT, build.cepRuntime());

var stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-rel-'));
function put(rel) { var d = path.join(stage, rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.cpSync(path.join(ROOT, rel), d, { recursive: true }); }
['cep', 'figma-plugin', 'ae/Fig2AE Panel.jsx', 'ae/Fig2AE.jsx', 'ae/geom.jsx',
 'Install.cmd', 'install.ps1', 'Uninstall.cmd', 'uninstall.ps1', 'install.js', 'INSTALL.txt'].forEach(put);

fs.mkdirSync(DIST, { recursive: true });
var zip = path.join(DIST, 'Fig2AE.zip');
if (fs.existsSync(zip)) fs.rmSync(zip);
if (process.platform === 'win32') {
  cp.execFileSync('powershell', ['-NoProfile', '-Command',
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('" + stage + "', '" + zip + "')"]);
} else {
  cp.execFileSync('zip', ['-qr', zip, '.'], { cwd: stage });
}
fs.rmSync(stage, { recursive: true, force: true });
fs.copyFileSync(zip, path.join(ROOT, 'Fig2AE.zip'));
fs.writeFileSync(path.join(ROOT, 'version.txt'), ver + '\n');
console.log('Fig2AE.zip + version.txt  v' + ver + '  (' + Math.round(fs.statSync(zip).size / 1024) + ' KB)');
