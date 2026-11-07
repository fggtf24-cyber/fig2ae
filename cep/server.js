/**
 * Fig2AE Server — runs inside After Effects as a hidden CEP extension that starts
 * with AE (the way AEUX does it). The Figma plugin POSTs the export DATA (JSON)
 * here. The .jsx is built from it with the importer installed next to this file
 * (runtime.js, made by build.js) — code from the request is never run: any web
 * page can POST to localhost. The .jsx gets its own folder (its pictures land
 * next to it and stay there as AE footage) and runs in AE through evalScript.
 *
 * Why not a polling ExtendScript task: app.scheduleTask pops "Cannot run a script
 * while a modal dialog is waiting for response" whenever any AE dialog is open.
 * evalScript just answers "EvalScript error." — the import waits for the dialog.
 */
var http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
var importer = require(path.join(__dirname, 'runtime.js'));
var VERSION = '0.4.11';
var updater = require(path.join(__dirname, 'updater.js'));

var PORT = 7251;
var BUSY = 'EvalScript error.';

/**
 * Panel settings (the Fig2AE panel in AE writes them, AEUX-style):
 *   target        'new' | 'current'  — new comp, or into the active comp
 *   imagePath     where exports and their images are kept ('' = Documents/Fig2AE)
 *   parametric    rectangles/ellipses as AE parametric shapes
 *   precompGroups every Figma group/frame becomes a precomp (off: a null parents its layers)
 *   groupNulls    a flattened group gets a null that parents its layers
 *   autoUpdate    install new GitHub releases by itself (updater.js)
 */
var DEFAULTS = { target: 'new', imagePath: '', parametric: false, precompGroups: false, groupNulls: true, autoUpdate: true };
function settingsDir() {
  return process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'Fig2AE')
                                      : path.join(os.homedir(), 'Library', 'Application Support', 'Fig2AE');
}
function readSettings(file) {
  var s = {}, k;
  try { s = JSON.parse(fs.readFileSync(file || path.join(settingsDir(), 'settings.json'), 'utf8')) || {}; } catch (e) {}
  var out = {};
  for (k in DEFAULTS) out[k] = (k in s && typeof s[k] === typeof DEFAULTS[k]) ? s[k] : DEFAULTS[k];
  if (out.target !== 'current') out.target = 'new';
  return out;
}
function writeSettings(obj, file) {
  file = file || path.join(settingsDir(), 'settings.json');
  var cur = readSettings(file), k;
  for (k in DEFAULTS) if (obj && k in obj && typeof obj[k] === typeof DEFAULTS[k]) cur[k] = obj[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
  return cur;
}

/**
 * Diagnostic log (GET /log, the "copy log" buttons in Figma and in the AE panel):
 * the last 300 server events, newest last, also kept in <settings dir>/server.log.
 */
var LOG = [], LOG_TO_FILE = true;
function logEvent(kind, msg, data) {
  var e = { t: new Date().toISOString(), kind: kind, msg: String(msg) };
  if (data !== undefined) e.data = data;
  LOG.push(e);
  if (LOG.length > 300) LOG.splice(0, LOG.length - 300);
  if (LOG_TO_FILE) try {
    fs.mkdirSync(settingsDir(), { recursive: true });
    var f = path.join(settingsDir(), 'server.log');
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.old'); } catch (e2) {}
    fs.appendFileSync(f, JSON.stringify(e) + '\n');
  } catch (e3) {}
}
function errInfo(e) { return { message: String(e && e.message || e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 8).join('\n') : '' }; }

/** ExtendScript that runs one export quietly and returns "OK\t<comp>\t<secs>\t<log joined by \u0001>" */
function importCode(file, opts) {
  return '(function(){var g=$.global,err="";g.F2A_QUIET=true;g.F2A_LAST=null;' +
    'g.F2A_OPTS=' + JSON.stringify(opts || null) + ';' +
    'try{$.evalFile(new File(' + JSON.stringify(file.split(path.sep).join('/')) + '));}catch(e){err=String(e);}' +
    'g.F2A_QUIET=false;g.F2A_OPTS=null;var r=g.F2A_LAST;if(!r)return "ERR\\t"+(err||"the import did not start. Turn on Allow Scripts to Write Files and Access Network in the Scripting & Expressions settings of After Effects");' +
    'return "OK\\t"+(r.comp?r.comp.name.replace(/[\\t\\r\\n]+/g," "):"")+"\\t"+r.secs+"\\t"+r.log.join("\\u0001").replace(/[\\t\\r\\n]+/g," ")+"\\t"+(r.mode||"new");})()';
}

function parseResult(out) {
  var p = String(out).split('\t');
  if (p[0] !== 'OK') return { ok: false, error: p.slice(1).join(' ') || String(out) };
  var r = { ok: !!p[1], comp: p[1], secs: parseFloat(p[2]) || 0, log: (p[3] || '').split('\u0001').filter(Boolean), mode: p[4] || 'new' };
  if (r.mode === 'cancelled') { r.ok = false; r.cancelled = true; r.error = 'Import cancelled — everything it added was removed'; }
  return r;
}

/**
 * Stop / Cancel of a running import: the importer (Fig2AE.jsx) looks for <settings dir>/cancel.txt
 * after every layer. "stop" keeps what is built, "cancel" removes it.
 */
function requestCancel(how) {
  fs.mkdirSync(settingsDir(), { recursive: true });
  fs.writeFileSync(path.join(settingsDir(), 'cancel.txt'), how === 'cancel' ? 'cancel' : 'stop');
}

/** the progress window over AE (progress.ps1, Windows): AE's own windows take no clicks while it imports */
function progressWindow(compName) {
  if (process.platform !== 'win32') return null;
  try {
    return require('child_process').spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', path.join(__dirname, 'progress.ps1'), '-Dir', settingsDir(), '-Name64', Buffer.from(String(compName || ''), 'utf8').toString('base64')],
      { windowsHide: true, stdio: 'ignore' });
  } catch (e) { logEvent('error', 'progress window: ' + e.message); return null; }
}

/**
 * The file name from the request URL. It ends up in a shell command on macOS (the importer's base64 call)
 * and any web page can POST here, so only what the Figma plugin itself produces gets through.
 */
function safeName(url) {
  var q = /[?&]name=([^&]*)/.exec(url), name = '';
  try { name = q ? decodeURIComponent(q[1]) : ''; } catch (e) {}
  name = name.replace(/[^\wЀ-ӿ.-]+/g, '_');
  return /^fig2ae_.*\.jsx$/.test(name) ? name : 'fig2ae_comp.jsx';
}

function stamp() {
  var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '_' + z(d.getHours()) + '-' + z(d.getMinutes()) + '-' + z(d.getSeconds());
}

/**
 * evalHost(code) -> Promise<string>: window.__adobe_cep__.evalScript in AE, a stub in tests.
 * opts: port, dir (where exports are kept), retryMs, waitMs.
 */
function start(evalHost, opts) {
  opts = opts || {};
  if (opts.dir) LOG_TO_FILE = false;                     // tests
  var settingsFile = opts.settingsFile;                  // tests; normally settingsDir()/settings.json
  function exportsDir(set) {
    if (opts.dir) return opts.dir;
    if (set.imagePath) return set.imagePath;
    return path.join(os.homedir(), 'Documents', 'Fig2AE');
  }
  var retryMs = opts.retryMs || 1000, waitMs = opts.waitMs || 30 * 60 * 1000;
  var queue = Promise.resolve(), seq = 0, busy = 0, timers = [], servers = [];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function run(name, body) {
    logEvent('import', 'received ' + name + ' (' + Math.round(body.length / 1024) + ' KB)');
    var doc = JSON.parse(body);                                  // data only, or it throws
    if (!doc || doc.app !== 'fig2ae' || !doc.comp) throw new Error('not a Fig2AE export');
    var jsx = importer.makeJsx(body, importer.runtime);
    var set = readSettings(settingsFile);
    var sub = stamp() + (++seq > 1 ? '_' + seq : ''), folder = path.join(exportsDir(set), sub), moved = null;
    try { fs.mkdirSync(folder, { recursive: true }); }
    catch (e) {
      // macOS can keep Documents off limits to After Effects, a chosen folder can be gone: the import still goes
      moved = path.dirname(folder);
      folder = path.join(settingsDir(), 'exports', sub);
      fs.mkdirSync(folder, { recursive: true });
      logEvent('error', 'cannot write to ' + moved + ' (' + e.code + '), using ' + folder);
    }
    var file = path.join(folder, name);
    fs.writeFileSync(file, jsx, 'utf8');
    var win = opts.dir ? null : progressWindow(doc.comp.name);
    try {
      for (var waited = 0; ; waited += retryMs) {
        var out = await evalHost(importCode(file, { target: set.target, parametric: set.parametric, precompGroups: set.precompGroups }));
        if (out !== BUSY) {
          var r = parseResult(out); r.file = file;
          if (moved && r.log) r.log.unshift('No access to "' + moved + '": images of this import are in "' + folder + '"');
          lastResult(r, doc);
          logEvent(r.ok ? 'import' : (r.cancelled ? 'import' : 'error'),
                   r.ok ? 'imported "' + r.comp + '" (' + r.mode + ', ' + r.secs.toFixed(1) + ' s)' : (r.cancelled ? 'import cancelled by the user' : 'import failed: ' + r.error),
                   { settings: set, aeLog: r.log, figmaWarnings: doc.warnings || [], file: file, raw: r.ok || r.cancelled ? undefined : String(out).slice(0, 2000) });
          return r;
        }
        if (waited === 0) logEvent('import', 'After Effects is busy (dialog open?) — waiting');
        if (waited >= waitMs) { logEvent('error', 'gave up waiting for After Effects'); return { ok: false, error: 'After Effects is busy (a dialog is open?) — import not done', file: file }; }
        await sleep(retryMs);
      }
    } finally {
      // the window closes itself when progress.json says the import is over; this is the safety net
      if (win) setTimeout(function () { try { win.kill(); } catch (e) {} }, 1500);
      try { fs.unlinkSync(path.join(settingsDir(), 'cancel.txt')); } catch (e) {}
    }
  }

  /** the panel shows the last import (it watches this file) */
  function lastResult(r, doc) {
    if (opts.dir) return;
    try {
      fs.mkdirSync(settingsDir(), { recursive: true });
      fs.writeFileSync(path.join(settingsDir(), 'last.json'), JSON.stringify({
        time: Date.now(), ok: r.ok, comp: r.comp, mode: r.mode, secs: r.secs, error: r.error || '',
        log: (r.log || []).concat(doc.warnings || []), folder: path.dirname(r.file)
      }));
    } catch (e) {}
  }

  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  function handle(req, res) {
    // the Figma plugin iframe has origin "null"; Chrome asks local servers for private-network consent
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && /^\/progress\b/.test(req.url)) {     // the importer writes it while building (Fig2AE.jsx)
      var pr = null;
      try { pr = JSON.parse(fs.readFileSync(path.join(settingsDir(), 'progress.json'), 'utf8')); } catch (e) {}
      send(res, 200, { ok: true, progress: pr });
      return;
    }
    if (req.method === 'GET' && /^\/log\b/.test(req.url)) {
      send(res, 200, { ok: true, app: 'fig2ae', version: VERSION, platform: process.platform + ' ' + os.release(), node: process.version,
                       settings: readSettings(settingsFile), update: updater.state(), events: LOG });
      return;
    }
    if (req.method === 'GET') {
      // the Figma plugin asks for the panel settings before it exports (precomp groups, parametric shapes)
      send(res, 200, { ok: true, app: 'fig2ae', version: VERSION, settings: readSettings(settingsFile), update: updater.state() });
      return;
    }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return; }
    if (/^\/cancel\b/.test(req.url)) {                                // Stop / Cancel from the Figma plugin
      if (!busy) { send(res, 200, { ok: false, error: 'no import is running' }); return; }
      var how = /[?&]how=cancel\b/.test(req.url) ? 'cancel' : 'stop';
      if (!opts.dir) try { requestCancel(how); } catch (e) { send(res, 500, { ok: false, error: String(e.message) }); return; }
      logEvent('import', how + ' requested from Figma');
      send(res, 200, { ok: true, how: how });
      return;
    }
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var name = safeName(req.url);
      var body = Buffer.concat(chunks).toString('utf8');
      busy++;
      queue = queue.then(function () { return run(name, body); })
        .then(function (r) { send(res, 200, r); }, function (e) { logEvent('error', 'request failed', errInfo(e)); send(res, 400, { ok: false, error: String(e && e.message || e) }); })
        .then(function () { busy--; });
    });
  }
  // loopback only; "localhost" may resolve to either address family
  var server = http.createServer(handle);
  server.listen(opts.port === undefined ? PORT : opts.port, '127.0.0.1');
  servers.push(server);
  /** stops listening and every timer: the page reloads itself after an update (index.html) */
  server.fig2aeStop = function (done) {
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    var n = servers.length;
    servers.forEach(function (sv) { try { sv.close(function () { if (--n === 0) done(); }); } catch (e) { if (--n === 0) done(); } });
    setTimeout(done, 3000);           // close waits for open connections (keep-alive): don't wait forever
  };
  if (opts.port === undefined) {
    servers.push(http.createServer(handle).on('error', function () {}).listen(PORT, '::1'));
    // auto-update: shortly after AE starts, then every 6 hours
    var auto = function () {
      if (readSettings(settingsFile).autoUpdate) updater.check(VERSION).then(function (u) {
        if (u.status !== 'latest') logEvent(u.status === 'error' ? 'error' : 'update', 'update ' + u.status + (u.latest ? ' ' + u.latest : '') + (u.error ? ': ' + u.error : ''));
      });
    };
    logEvent('start', 'Fig2AE ' + VERSION + ' server started');
    // an import that was still running when After Effects went away (crash, or closed while it looked frozen)
    try {
      var pf = path.join(settingsDir(), 'progress.json'), pr = JSON.parse(fs.readFileSync(pf, 'utf8'));
      if (pr.state === 'running') {
        logEvent('error', 'the previous import did not finish: After Effects closed or crashed at layer ' + pr.n + ' of ' + pr.total +
                 ' ("' + pr.layer + '") of "' + pr.comp + '", ' + Math.round((Date.now() - pr.t) / 60000) + ' min ago', pr);
        pr.state = 'abandoned';
        fs.writeFileSync(pf, JSON.stringify(pr));
      }
    } catch (e) {}
    process.on('uncaughtException', function (e) { logEvent('error', 'uncaught exception', errInfo(e)); });
    process.on('unhandledRejection', function (e) { logEvent('error', 'unhandled rejection', errInfo(e)); });
    timers.push(setTimeout(auto, 5 * 1000));
    timers.push(setInterval(auto, 6 * 3600 * 1000));
    // a new version on disk (auto-update or the panel's "Check for updates"): reload into it, no AE restart,
    // unless the extension manifest changed or an import is running
    var applying = false;
    timers.push(setInterval(function () {
      var u = updater.state();
      if (applying || busy || !opts.onUpdate || u.status !== 'installed' || u.restart || !updater.newer(u.latest, VERSION)) return;
      applying = true;
      logEvent('update', 'applying ' + u.latest + ' without restarting After Effects');
      opts.onUpdate(server.fig2aeStop);
    }, 3000));
  }
  return server;
}

module.exports = { start: start, logEvent: logEvent, importCode: importCode, parseResult: parseResult, safeName: safeName, readSettings: readSettings, writeSettings: writeSettings,
                   requestCancel: requestCancel,
                   settingsDir: settingsDir, DEFAULTS: DEFAULTS, PORT: PORT, BUSY: BUSY, VERSION: VERSION };
