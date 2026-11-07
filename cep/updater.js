/**
 * Fig2AE auto-update. Runs inside After Effects (the hidden server checks on start
 * and every 6 hours; the panel has "Check for updates").
 *
 * Same scheme as VoiceType: the main branch of REPO holds version.txt and the built
 * Fig2AE.zip (make-release.js). When version.txt on GitHub is newer, Fig2AE.zip is
 * downloaded and unpacked over the installed copy:
 *   cep/          -> this extension's folder (takes effect after After Effects restarts)
 *   figma-plugin/ -> the Figma plugin folder written by the installers (next plugin run)
 *   ae/Fig2AE Panel.jsx -> the fallback ScriptUI panel of every AE version
 * State goes to <settings dir>/update.json for the panel and the Figma plugin.
 */
var https = require('https'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

var REPO = 'fggtf24-cyber/fig2ae';
var BRANCH = 'main';
var RAW = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/';
var ASSET = 'Fig2AE.zip';

function settingsDir() {
  return process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'Fig2AE')
                                      : path.join(os.homedir(), 'Library', 'Application Support', 'Fig2AE');
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } }
function writeState(s) {
  try { fs.mkdirSync(settingsDir(), { recursive: true }); fs.writeFileSync(path.join(settingsDir(), 'update.json'), JSON.stringify(s)); } catch (e) {}
  return s;
}
function state() { return readJson(path.join(settingsDir(), 'update.json')) || {}; }

/** 1.2.10 > 1.2.9; tags may start with "v" */
function newer(a, b) {
  var x = String(a).replace(/^v/, '').split('.'), y = String(b).replace(/^v/, '').split('.');
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var p = parseInt(x[i] || '0', 10), q = parseInt(y[i] || '0', 10);
    if (p !== q) return p > q;
  }
  return false;
}

function get(url, asFile, hops, asText) {
  return new Promise(function (resolve, reject) {
    var req = https.get(url + (asText ? (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now() : ''), { headers: { 'User-Agent': 'Fig2AE-updater', 'Accept': asFile ? 'application/octet-stream' : 'application/vnd.github+json' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((hops || 0) > 5) return reject(new Error('too many redirects'));
        return resolve(get(res.headers.location, asFile, (hops || 0) + 1, asText));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      if (asFile) {
        var out = fs.createWriteStream(asFile);
        res.pipe(out);
        res.on('aborted', function () { reject(new Error('download interrupted')); });
        out.on('finish', function () { out.close(function () { resolve(asFile); }); });
        out.on('error', reject);
      } else {
        var d = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { d += c; });
        res.on('end', function () { if (asText) return resolve(d); try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    });
    req.setTimeout(60000, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + dest.replace(/'/g, "''") + "' -Force"], { windowsHide: true });
  } else if (process.platform === 'darwin') {
    cp.execFileSync('ditto', ['-x', '-k', zip, dest]);
  } else {
    cp.execFileSync('unzip', ['-q', '-o', zip, '-d', dest]);            // tests on Linux
  }
}

/** copies src over dst file by file (files the running AE holds open are overwritten in place) */
function copyOver(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src).forEach(function (n) {
    var s = path.join(src, n), d = path.join(dst, n);
    if (fs.statSync(s).isDirectory()) copyOver(s, d);
    else fs.copyFileSync(s, d);
  });
}

function aeScriptFolders() {
  var base = process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'Adobe', 'After Effects')
                                          : path.join(os.homedir(), 'Library', 'Preferences', 'Adobe', 'After Effects');
  try { return fs.readdirSync(base).filter(function (d) { return /^\d+(\.\d+)?$/.test(d); }).map(function (d) { return path.join(base, d, 'Scripts', 'ScriptUI Panels'); }); }
  catch (e) { return []; }
}

var running = null;
/**
 * check(current, {install: true}) -> Promise<state>
 * state: { status: 'latest'|'available'|'installed'|'error', current, latest, time, error?, notes? }
 */
function check(current, opts) {
  if (running) return running;
  opts = opts || {};
  running = (async function () {
    var s = { current: current, time: Date.now() };
    try {
      var txt = await get(RAW + 'version.txt', null, 0, true);
      s.latest = String(txt).trim();
      s.url = 'https://github.com/' + REPO;
      if (!/^\d+(\.\d+)*$/.test(s.latest)) throw new Error('bad version.txt on GitHub: ' + s.latest.slice(0, 40));
      if (!newer(s.latest, current)) { s.status = 'latest'; return writeState(s); }
      var prev = state();
      if (prev.status === 'installed' && prev.latest === s.latest) { s.status = 'installed'; s.restart = prev.restart; return writeState(s); }   // waiting for an AE restart
      if (opts.install === false) { s.status = 'available'; return writeState(s); }

      var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-update-'));
      var zip = await get(RAW + ASSET, path.join(tmp, ASSET));
      var out = path.join(tmp, 'x');
      unzip(zip, out);
      // the whole build must be there before anything is touched
      var NEED = ['cep/CSXS/manifest.xml', 'cep/server.js', 'cep/runtime.js', 'cep/updater.js', 'cep/index.html',
                  'cep/panel/index.html', 'cep/panel/panel.js', 'cep/panel/host.jsx',
                  'figma-plugin/manifest.json', 'figma-plugin/code.js', 'figma-plugin/ui.html'];
      NEED.forEach(function (f) {
        var p = path.join(out, f);
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) throw new Error('the downloaded archive is incomplete (' + f + ')');
      });

      // copy with a backup: if anything fails half-way, the old version is put back
      var inst = readJson(path.join(settingsDir(), 'install.json')) || {};
      var targets = [[path.join(out, 'cep'), opts.cepDir || __dirname]];
      if (inst.figmaPlugin) targets.push([path.join(out, 'figma-plugin'), inst.figmaPlugin]);
      var backups = [];
      try {
        targets.forEach(function (t, i) {
          var b = path.join(tmp, 'backup' + i);
          if (fs.existsSync(t[1])) { copyOver(t[1], b); backups.push([b, t[1]]); }
        });
        // a changed manifest (new panel, new host versions) only takes effect after After Effects restarts;
        // anything else is picked up live: the server and the panel reload themselves
        var strip = function (f) { try { return fs.readFileSync(f, 'utf8').replace(/Version="[\d.]+"/g, ''); } catch (e) { return ''; } };
        s.restart = strip(path.join(targets[0][1], 'CSXS', 'manifest.xml')) !== strip(path.join(out, 'cep', 'CSXS', 'manifest.xml'));
        targets.forEach(function (t) { copyOver(t[0], t[1]); });
      } catch (e) {
        backups.forEach(function (b) { try { copyOver(b[0], b[1]); } catch (e2) {} });
        throw new Error('update not installed, the old version was kept: ' + (e && e.message || e));
      }
      var panel = path.join(out, 'ae', 'Fig2AE Panel.jsx');
      if (fs.existsSync(panel)) aeScriptFolders().forEach(function (d) { try { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(panel, path.join(d, 'Fig2AE.jsx')); } catch (e) {} });
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      s.status = 'installed';
      return writeState(s);
    } catch (e) {
      s.status = 'error'; s.error = String(e && e.message || e);
      return writeState(s);
    }
  })().finally(function () { running = null; });
  return running;
}

module.exports = { check: check, state: state, newer: newer, REPO: REPO, ASSET: ASSET };
