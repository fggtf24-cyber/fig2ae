/**
 * node make-installer.js
 * dist/Fig2AE-Setup.exe — one-click Windows installer (installer/Setup.cs, compiled with the
 * csc.exe that ships with every Windows; the payload is embedded as a resource).
 * dist/Fig2AE-mac.zip    — the same files + install.js for macOS.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var build = require('./build.js');

var ROOT = __dirname, DIST = path.join(ROOT, 'dist');
var CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

fs.writeFileSync(build.UI, build.uiHtml());
fs.writeFileSync(build.CEP_RT, build.cepRuntime());
fs.mkdirSync(DIST, { recursive: true });

// payload: exactly what Setup installs
var stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-stage-'));
fs.cpSync(path.join(ROOT, 'figma-plugin'), path.join(stage, 'payload', 'figma-plugin'), { recursive: true });
fs.cpSync(path.join(ROOT, 'cep'), path.join(stage, 'payload', 'cep'), { recursive: true });
fs.mkdirSync(path.join(stage, 'payload', 'ae'));
fs.copyFileSync(path.join(ROOT, 'ae', 'Fig2AE Panel.jsx'), path.join(stage, 'payload', 'ae', 'Fig2AE Panel.jsx'));
function zip(src, dst) {
  if (fs.existsSync(dst)) fs.rmSync(dst);
  cp.execFileSync('powershell', ['-NoProfile', '-Command',
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('" + src + "', '" + dst + "')"]);
}
var payload = path.join(stage, 'payload.zip');
zip(path.join(stage, 'payload'), payload);

var exe = path.join(DIST, 'Fig2AE-Setup.exe');
cp.execFileSync(CSC, ['/nologo', '/target:winexe', '/optimize+', '/out:' + exe,
  '/win32manifest:' + path.join(ROOT, 'installer', 'app.manifest'),
  '/r:System.IO.Compression.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  '/resource:' + payload + ',payload.zip', path.join(ROOT, 'installer', 'Setup.cs')], { stdio: 'inherit' });
console.log('dist/Fig2AE-Setup.exe (' + Math.round(fs.statSync(exe).size / 1024) + ' KB)');

// macOS: payload + install.js + INSTALL.txt
fs.copyFileSync(path.join(ROOT, 'install.js'), path.join(stage, 'payload', 'install.js'));
fs.copyFileSync(path.join(ROOT, 'INSTALL.txt'), path.join(stage, 'payload', 'INSTALL.txt'));
fs.copyFileSync(path.join(ROOT, 'ae', 'Fig2AE.jsx'), path.join(stage, 'payload', 'ae', 'Fig2AE.jsx'));
fs.copyFileSync(path.join(ROOT, 'ae', 'geom.jsx'), path.join(stage, 'payload', 'ae', 'geom.jsx'));
var mac = path.join(DIST, 'Fig2AE-mac.zip');
zip(path.join(stage, 'payload'), mac);
fs.rmSync(stage, { recursive: true, force: true });
var old = path.join(DIST, 'Fig2AE.zip');
if (fs.existsSync(old)) fs.rmSync(old);
console.log('dist/Fig2AE-mac.zip');
