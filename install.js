/**
 * node install.js   (macOS; on Windows use dist/Fig2AE-Setup.exe)
 * 1. Fig2AE Server (cep/) -> the user's CEP extensions folder: starts with After
 *    Effects and takes exports straight from the Figma plugin.
 * 2. Unsigned extensions need PlayerDebugMode=1 (per CSXS version, user level only).
 * 3. The manual-import panel into every After Effects version; removes the old
 *    polling watcher (Scripts/Startup/Fig2AE Startup.jsx) of earlier versions.
 * Restart After Effects afterwards.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');

var WIN = process.platform === 'win32';
var CSXS = [9, 10, 11, 12, 13, 14, 15, 16];
var BOM = String.fromCharCode(0xFEFF);    // ExtendScript reads files without a BOM as ANSI

// 1. CEP extension
var cepDir = WIN ? path.join(process.env.APPDATA || '', 'Adobe', 'CEP', 'extensions', 'fig2ae')
                 : path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', 'fig2ae');
fs.rmSync(cepDir, { recursive: true, force: true });
fs.cpSync(path.join(__dirname, 'cep'), cepDir, { recursive: true });
console.log('Fig2AE Server -> ' + cepDir);

// 2. debug mode for unsigned extensions, only where it is not set yet
CSXS.forEach(function (v) {
  try {
    if (WIN) {
      var key = 'HKCU\\Software\\Adobe\\CSXS.' + v, cur = '';
      try { cur = cp.execSync('reg query "' + key + '" /v PlayerDebugMode', { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) {}
      if (!/PlayerDebugMode\s+REG_SZ\s+1/.test(cur)) cp.execSync('reg add "' + key + '" /v PlayerDebugMode /t REG_SZ /d 1 /f', { stdio: 'ignore' });
    } else {
      cp.execSync('defaults write com.adobe.CSXS.' + v + ' PlayerDebugMode 1', { stdio: 'ignore' });
    }
  } catch (e) { console.error('CSXS.' + v + ': could not set PlayerDebugMode (' + e.message + ')'); }
});

// 3. panel per AE version
var base = WIN ? path.join(process.env.APPDATA || '', 'Adobe', 'After Effects')
               : path.join(os.homedir(), 'Library', 'Preferences', 'Adobe', 'After Effects');
var versions = fs.existsSync(base) ? fs.readdirSync(base).filter(function (d) { return /^\d+(\.\d+)?$/.test(d); }) : [];
if (!versions.length) console.error('After Effects settings folder not found (' + base + ') — import panel not installed');
versions.forEach(function (v) {
  var scripts = path.join(base, v, 'Scripts');
  var panels = path.join(scripts, 'ScriptUI Panels');
  fs.mkdirSync(panels, { recursive: true });
  fs.writeFileSync(path.join(panels, 'Fig2AE.jsx'), BOM + fs.readFileSync(path.join(__dirname, 'ae', 'Fig2AE Panel.jsx'), 'utf8').replace(/^﻿/, ''));
  fs.rmSync(path.join(scripts, 'Startup', 'Fig2AE Startup.jsx'), { force: true });
  console.log('AE ' + v + ': import panel -> ' + panels);
});
// 4. the Figma plugin in a fixed place + install.json for auto-update (cep/updater.js)
var cfgDir = WIN ? path.join(process.env.APPDATA || '', 'Fig2AE') : path.join(os.homedir(), 'Library', 'Application Support', 'Fig2AE');
var plugin = WIN ? path.join(process.env.LOCALAPPDATA || cfgDir, 'Fig2AE', 'figma-plugin') : path.join(cfgDir, 'figma-plugin');
fs.rmSync(plugin, { recursive: true, force: true });
fs.cpSync(path.join(__dirname, 'figma-plugin'), plugin, { recursive: true });
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'install.json'), JSON.stringify({ figmaPlugin: plugin, cep: cepDir }, null, 2));
console.log('Figma plugin -> ' + path.join(plugin, 'manifest.json') + '  (Figma: Plugins > Development > Import plugin from manifest…)');
console.log('Restart After Effects. In Figma press "Send selection to After Effects" — the comp appears by itself.');
