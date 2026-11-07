/**
 * node make-release.js            -> Fig2AE-Setup.exe + Fig2AE.zip + version.txt in the repo root
 *   Fig2AE-Setup.exe: the one-file installer (installer/Setup.cs, Fig2AE.zip inside as a resource);
 *   built with csc.exe on Windows (ships with every Windows) or mono's mcs + mingw windres elsewhere.
 *   Fig2AE.zip: what auto-update downloads.
 * node make-release.js bump 0.4.1 -> writes the version everywhere it lives, then builds
 *
 * Publishing (same scheme as VoiceType): commit Fig2AE.zip + version.txt and push to main.
 * The site links to github.com/fggtf24-cyber/fig2ae/raw/main/Fig2AE.zip; every installed Fig2AE
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
    if (f === 'installer/Setup.cs') {
      var am = path.join(ROOT, 'installer', 'app.manifest');
      fs.writeFileSync(am, fs.readFileSync(am, 'utf8').replace(/(assemblyIdentity version=")[\d.]+/, '$1' + v + '.0'));
    }
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
 'Install.cmd', 'install.ps1', 'Uninstall.cmd', 'uninstall.ps1', 'install-mac.sh', 'INSTALL.txt'].forEach(put);

fs.mkdirSync(DIST, { recursive: true });
var zip = path.join(DIST, 'Fig2AE.zip');
if (fs.existsSync(zip)) fs.rmSync(zip);
if (process.platform === 'win32') {
  // Windows' own bsdtar: entries with "/" (ZipFile of .NET Framework writes "cep\server.js", which macOS unpacks as a file name)
  cp.execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip].concat(fs.readdirSync(stage)), { cwd: stage });
} else {
  cp.execFileSync('zip', ['-qr', zip, '.'], { cwd: stage });
}
fs.rmSync(stage, { recursive: true, force: true });
fs.copyFileSync(zip, path.join(ROOT, 'Fig2AE.zip'));
buildExe(path.join(ROOT, 'Fig2AE.zip'), path.join(ROOT, 'Fig2AE-Setup.exe'));
fs.writeFileSync(path.join(ROOT, 'version.txt'), ver + '\n');
console.log('Fig2AE.zip + version.txt  v' + ver + '  (' + Math.round(fs.statSync(zip).size / 1024) + ' KB)');

function buildExe(payload, exe) {
  var inst = path.join(ROOT, 'installer');
  var refs = ['System.IO.Compression.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll'];
  if (process.platform === 'win32') {
    var csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    cp.execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', '/out:' + exe,
      '/win32manifest:' + path.join(inst, 'app.manifest'), '/win32icon:' + path.join(inst, 'fig2ae.ico')]
      .concat(refs.map(function (r) { return '/r:' + r; }), ['/resource:' + payload + ',Fig2AE.zip', path.join(inst, 'Setup.cs')]), { stdio: 'inherit' });
  } else {
    // mcs takes the manifest and the icon only as one compiled .res
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-res-'));
    fs.writeFileSync(path.join(tmp, 'setup.rc'), '1 24 "' + path.join(inst, 'app.manifest') + '"\n32512 ICON "' + path.join(inst, 'fig2ae.ico') + '"\n');
    try {
      cp.execFileSync('x86_64-w64-mingw32-windres', ['--preprocessor=cat', '-i', path.join(tmp, 'setup.rc'), '-O', 'res', '-o', path.join(tmp, 'setup.res')]);
      cp.execFileSync('mcs', ['-nologo', '-target:winexe', '-optimize+', '-out:' + exe, '-win32res:' + path.join(tmp, 'setup.res')]
        .concat(refs.map(function (r) { return '-r:' + r; }), ['-resource:' + payload + ',Fig2AE.zip', path.join(inst, 'Setup.cs')]), { stdio: 'inherit' });
    } catch (e) {
      console.error('Fig2AE-Setup.exe NOT built (needs mono-mcs + binutils-mingw-w64): ' + e.message);
      process.exitCode = 1;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  if (fs.existsSync(exe)) console.log('Fig2AE-Setup.exe  (' + Math.round(fs.statSync(exe).size / 1024) + ' KB)');
}
