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
['cep', 'figma-plugin', 'ae/Fig2AE Panel.jsx', 'ae/Fig2AE.jsx', 'ae/geom.jsx', 'ae/fontmatch.jsx',
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
buildMacZip(path.join(ROOT, 'Fig2AE-mac.zip'));
fs.writeFileSync(path.join(ROOT, 'version.txt'), ver + '\n');
console.log('Fig2AE.zip + version.txt  v' + ver + '  (' + Math.round(fs.statSync(zip).size / 1024) + ' KB)');

/**
 * Fig2AE-mac.zip: Fig2AE/ with "Install Fig2AE.command" (double-click), the uninstaller, the guide,
 * and files/ (install-mac.sh + what it installs). Written here, not by tar/zip: the .command files
 * need the Unix executable bit, which an archive made on Windows never has — without it macOS
 * won't run them.
 */
function buildMacZip(out) {
  var zlib = require('zlib'), entries = [];
  function add(name, file, exec) { entries.push({ name: 'Fig2AE/' + name, data: fs.readFileSync(file), mode: exec ? 0o100755 : 0o100644 }); }
  function addTree(rel, under) {
    var p = path.join(ROOT, rel);
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach(function (n) { addTree(rel + '/' + n, under); });
    else add(under + rel, p, /\.sh$/.test(rel));
  }
  var mac = path.join(ROOT, 'installer', 'mac');
  fs.readdirSync(mac).forEach(function (n) { add(n, path.join(mac, n), /\.command$/.test(n)); });
  ['cep', 'figma-plugin', 'ae/Fig2AE Panel.jsx', 'install-mac.sh'].forEach(function (r) { addTree(r, 'files/'); });

  var CRC = [];
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
  function crc32(b) { var c = 0xffffffff; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  var d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  var parts = [], central = [], offset = 0;
  entries.forEach(function (e) {
    var name = Buffer.from(e.name, 'utf8'), packed = zlib.deflateRawSync(e.data), crc = crc32(e.data);
    var h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);   // UTF-8 names, deflate
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26);
    var c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6);                    // made by Unix: modes count
    c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE((e.mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    parts.push(h, name, packed);
    central.push(c, name);
    offset += 30 + name.length + packed.length;
  });
  var cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat(parts.concat([cd, end])));
  console.log('Fig2AE-mac.zip  (' + Math.round(fs.statSync(out).size / 1024) + ' KB, ' + entries.length + ' files)');
}

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
