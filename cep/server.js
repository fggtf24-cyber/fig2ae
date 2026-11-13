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
var VERSION = '0.4.16';
var updater = require(path.join(__dirname, 'updater.js'));
var fonts = require(path.join(__dirname, 'fonts.js'));
var telemetry = require(path.join(__dirname, 'telemetry.js'));

var PORT = 7251;
var BUSY = 'EvalScript error.';

/**
 * Panel settings (the Fig2AE panel in AE writes them, AEUX-style):
 *   target        'new' | 'current'  — new comp, or into the active comp
 *                 (an export with replace: true always goes as 'replace': into the layer selected in AE)
 *   imagePath     where exports and their images are kept ('' = Documents/Fig2AE)
 *   parametric    rectangles/ellipses as AE parametric shapes
 *   precompGroups every Figma group/frame becomes a precomp (off: a null parents its layers)
 *   groupNulls    a flattened group gets a null that parents its layers
 *   autoUpdate    install new GitHub releases by itself (updater.js)
 *   sendLogs      send an anonymous report after each import (telemetry.js); logsAsked: the user was asked once
 *   installId     random id of this install (only made when sendLogs is turned on)
 */
var DEFAULTS = { target: 'new', imagePath: '', parametric: false, precompGroups: false, groupNulls: true, autoUpdate: true,
                 unprecompTrim: false, unprecompSelect: true, unprecompExtend: false,
                 sendLogs: false, logsAsked: false, installId: '' };   // Un-Precomp: layers keep the in/out of the precomp layer (panel gear)
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
  if (obj && typeof obj.sendLogs === 'boolean') cur.logsAsked = true;     // answered, here or in the Figma plugin
  if (cur.sendLogs && !cur.installId) cur.installId = require('crypto').randomBytes(12).toString('hex');
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
        var out = await evalHost(importCode(file, { target: doc.update === true ? 'update' : doc.replace === true ? 'replace' : set.target, parametric: set.parametric, precompGroups: set.precompGroups }));
        if (out !== BUSY) {
          var r = parseResult(out); r.file = file;
          if (moved && r.log) r.log.unshift('No access to "' + moved + '": images of this import are in "' + folder + '"');
          lastResult(r, doc);
          logEvent(r.ok ? 'import' : (r.cancelled ? 'import' : 'error'),
                   r.ok ? 'imported "' + r.comp + '" (' + r.mode + ', ' + r.secs.toFixed(1) + ' s)' : (r.cancelled ? 'import cancelled by the user' : 'import failed: ' + r.error),
                   { settings: set, aeLog: r.log, figmaWarnings: doc.warnings || [], file: file, raw: r.ok || r.cancelled ? undefined : String(out).slice(0, 2000) });
          if (!opts.dir) telemetry.send(telemetry.importReport(VERSION, readSettings(settingsFile), r, doc, out), readSettings(settingsFile));
          return r;
        }
        if (waited === 0) logEvent('import', 'After Effects is busy (dialog open?) — waiting');
        if (waited >= waitMs) { logEvent('error', 'gave up waiting for After Effects'); return { ok: false, error: 'After Effects is busy (a dialog is open?) — import not done', file: file }; }
        await sleep(retryMs);
      }
    } finally {
      // the window closes itself when progress.json says the import is over; this is the safety net
      // (unless it now lists fonts AE did not find: then the user closes it)
      var keep = false;
      try { var pj = JSON.parse(fs.readFileSync(path.join(settingsDir(), 'progress.json'), 'utf8')); keep = pj.state === 'done' && ((pj.missing && pj.missing.length > 0) || (pj.renamed && pj.renamed.length > 0)); } catch (e) {}
      if (win && !keep) setTimeout(function () { try { win.kill(); } catch (e) {} }, 1500);
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
    // a newer Fig2AE server found this one still holding the port (left over from a live update): step aside.
    // The custom header makes browsers preflight it, and the preflight does not allow it: web pages can't send this.
    if (req.method === 'POST' && /^\/shutdown\b/.test(req.url) && req.headers['x-fig2ae'] === 'shutdown') {
      logEvent('update', 'asked to step aside by a newer server');
      send(res, 200, { ok: true });
      setTimeout(function () { server.fig2aeStop(function () {}); }, 50);
      return;
    }
    if (req.method === 'GET' && /^\/progress\b/.test(req.url)) {     // the importer writes it while building (Fig2AE.jsx)
      var pr = null;
      try { pr = JSON.parse(fs.readFileSync(path.join(settingsDir(), 'progress.json'), 'utf8')); } catch (e) {}
      send(res, 200, { ok: true, progress: pr });
      return;
    }
    // "Report a problem" in the Figma plugin: one report, sent right now (the user asked for it), marked as a complaint
    if (req.method === 'POST' && /^\/report\b/.test(req.url)) {
      var rb = [], rl = 0;
      req.on('data', function (c) { rl += c.length; if (rl > 200000) req.destroy(); else rb.push(c); });
      req.on('end', function () {
        var v = null;
        try { v = JSON.parse(Buffer.concat(rb).toString('utf8')); } catch (e) {}
        if (!v) { send(res, 400, { ok: false, error: 'bad request' }); return; }
        var set = readSettings(settingsFile);
        if (!set.installId) set = writeSettings({ installId: require('crypto').randomBytes(12).toString('hex') }, settingsFile);
        var last = null;
        try { last = JSON.parse(fs.readFileSync(path.join(settingsDir(), 'last.json'), 'utf8')); } catch (e) {}
        var rep = telemetry.complaint(VERSION, set, v.note, v.figmaLog, LOG, last);
        logEvent('report', 'problem report sent by the user');
        telemetry.send(rep, set, true).then(function (sent) { send(res, 200, { ok: sent }); });
      });
      return;
    }
    // the Figma plugin asks once whether anonymous logs may be sent: only these two settings can be set from there
    if (req.method === 'POST' && /^\/settings\/logs\b/.test(req.url)) {
      var sb = [];
      req.on('data', function (c) { sb.push(c); if (sb.length > 20) req.destroy(); });
      req.on('end', function () {
        var v = null;
        try { v = JSON.parse(Buffer.concat(sb).toString('utf8')); } catch (e) {}
        if (!v || typeof v.sendLogs !== 'boolean') { send(res, 400, { ok: false, error: 'sendLogs: true / false' }); return; }
        var set2 = writeSettings({ sendLogs: v.sendLogs, logsAsked: true }, settingsFile);
        logEvent('settings', 'anonymous logs ' + (set2.sendLogs ? 'on' : 'off'));
        send(res, 200, { ok: true, settings: set2 });
      });
      return;
    }
    // "Check for updates" in the Figma plugin: the same check as the AE panel's button (installs from GitHub)
    if (req.method === 'POST' && /^\/update\/check\b/.test(req.url)) {
      logEvent('update', 'check requested from the Figma plugin');
      updater.check(VERSION).then(function (u) { send(res, 200, { ok: true, version: VERSION, update: u }); },
                                  function (e) { send(res, 200, { ok: false, error: String(e && e.message || e) }); });
      return;
    }
    // the installed Figma plugin files: an open plugin window reloads itself into them (no closing it)
    if (req.method === 'GET' && /^\/figma\/(code\.js|ui\.html)\b/.test(req.url)) {
      var inst = null;
      try { inst = JSON.parse(fs.readFileSync(path.join(settingsDir(), 'install.json'), 'utf8')); } catch (e) {}
      var dir = (inst && inst.figmaPlugin) || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Fig2AE', 'figma-plugin');
      var fname = /code\.js/.test(req.url) ? 'code.js' : 'ui.html';
      try {
        var body = fs.readFileSync(path.join(dir, fname), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      } catch (e) { send(res, 404, { ok: false, error: 'the Figma plugin is not installed in ' + dir }); }
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
      if (/^\/fonts\/(check|install)\b/.test(req.url)) { fontsRequest(req, res, Buffer.concat(chunks).toString('utf8')); return; }
      var name = safeName(req.url);
      var body = Buffer.concat(chunks).toString('utf8');
      busy++;
      queue = queue.then(function () { return run(name, body); })
        .then(function (r) { send(res, 200, r); }, function (e) { logEvent('error', 'request failed', errInfo(e)); send(res, 400, { ok: false, error: String(e && e.message || e) }); })
        .then(function () { busy--; });
    });
  }
  /**
   * Fonts the Figma plugin is about to send (cep/fonts.js):
   *   POST /fonts/check   {fonts:[{family,style}]} -> {ok, missing, renamed}   (AE busy: ok false, busy true)
   *   POST /fonts/install {fonts:[…]}              -> {ok, installed, unavailable, failed, missing}
   * Data only, like /import: nothing from the request is run.
   */
  async function fontsRequest(req, res, body) {
    var list;
    try { list = JSON.parse(body).fonts; } catch (e) { list = null; }
    if (!Array.isArray(list)) { send(res, 400, { ok: false, error: 'fonts: [{family, style}] expected' }); return; }
    list = list.filter(function (f) { return f && typeof f.family === 'string' && typeof f.style === 'string'; }).slice(0, 200);
    if (busy) { send(res, 200, { ok: false, busy: true }); return; }
    try {
      if (/^\/fonts\/install/.test(req.url)) {
        var r = await fonts.install(list, opts.fontsOpts);
        logEvent('fonts', 'installed ' + r.installed.length + ', not on Google Fonts ' + r.unavailable.length + ', failed ' + r.failed.length, r);
        var after = await fonts.installed(evalHost);                  // does AE see them now?
        r.missing = after ? fonts.check(list, after).missing : null;
        r.ok = true;
        send(res, 200, r);
        return;
      }
      var have = await fonts.installed(evalHost);
      if (!have) { send(res, 200, { ok: false, busy: true }); return; }
      var c = fonts.check(list, have);
      // missing ones: can they be downloaded? (google: true / false / null = could not ask)
      if (c.missing.length) {
        var g = await fonts.onGoogle(c.missing.map(function (f) { return f.family; }).filter(function (v, i, a) { return a.indexOf(v) === i; }), opts.fontsOpts);
        c.missing.forEach(function (f) { f.google = g[f.family]; });
      }
      c.ok = true;
      send(res, 200, c);
    } catch (e) { logEvent('error', 'fonts request failed', errInfo(e)); send(res, 500, { ok: false, error: String(e && e.message || e) }); }
  }

  // loopback only; "localhost" may resolve to either address family
  var sockets = new Set();
  function track(sv) {
    sv.on('connection', function (s) { sockets.add(s); s.on('close', function () { sockets.delete(s); }); });
    return sv;
  }
  /**
   * The port may still be held for a moment by the server this one replaces (live update), or by a
   * leftover one: ask it to step aside (POST /shutdown) and try again for a few seconds.
   */
  function listen(sv, host, tries) {
    sv.listen(opts.port === undefined ? PORT : opts.port, host);
    if (opts.port !== undefined) return;
    sv.on('error', function (e) {
      if (e.code !== 'EADDRINUSE') return;
      if (tries <= 0) { if (host === '127.0.0.1') logEvent('error', 'port ' + PORT + ' stays busy — restart After Effects'); return; }
      if (tries === 8 && host === '127.0.0.1') {
        var q = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/shutdown', headers: { 'X-Fig2AE': 'shutdown' }, timeout: 2000 });
        q.on('error', function () {}); q.on('timeout', function () { q.destroy(); }); q.end();
      }
      setTimeout(function () { sv.removeAllListeners('error'); sv.on('error', function () {}); listen(sv, host, tries - 1); }, 1000);
    });
  }
  var server = track(http.createServer(handle));
  listen(server, '127.0.0.1', 8);
  servers.push(server);
  /** stops listening and every timer: the page reloads itself after an update (index.html) */
  server.fig2aeStop = function (done) {
    // done exactly once: calling it twice reloaded the page twice and left this server listening as a
    // zombie (its AE bridge dead), so every request hung — seen in 0.4.11
    var called = false, fallback = null;
    function finish() { if (called) return; called = true; clearTimeout(fallback); done(); }
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    var n = servers.length;
    servers.forEach(function (sv) { try { sv.close(function () { if (--n === 0) finish(); }); } catch (e) { if (--n === 0) finish(); } });
    // close waits for open connections (keep-alive, a request waiting for AE): end them
    sockets.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    fallback = setTimeout(finish, 3000);
  };
  if (opts.port === undefined) {
    var six = track(http.createServer(handle)); six.on('error', function () {}); listen(six, '::1', 8); servers.push(six);
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
