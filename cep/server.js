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
var VERSION = '0.4.0';
var updater = require(path.join(__dirname, 'updater.js'));

var PORT = 7251;
var BUSY = 'EvalScript error.';

/**
 * Panel settings (the Fig2AE panel in AE writes them, AEUX-style):
 *   target        'new' | 'current'  — new comp, or into the active comp
 *   imagePath     where exports and their images are kept ('' = Documents/Fig2AE)
 *   parametric    rectangles/ellipses as AE parametric shapes
 *   precompGroups every Figma group/frame becomes a precomp (off: a null parents its layers)
 *   autoUpdate    install new GitHub releases by itself (updater.js)
 */
var DEFAULTS = { target: 'new', imagePath: '', parametric: false, precompGroups: false, autoUpdate: true };
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

/** ExtendScript that runs one export quietly and returns "OK\t<comp>\t<secs>\t<log joined by \u0001>" */
function importCode(file, opts) {
  return '(function(){var g=$.global,err="";g.F2A_QUIET=true;g.F2A_LAST=null;' +
    'g.F2A_OPTS=' + JSON.stringify(opts || null) + ';' +
    'try{$.evalFile(new File(' + JSON.stringify(file.split(path.sep).join('/')) + '));}catch(e){err=String(e);}' +
    'g.F2A_QUIET=false;g.F2A_OPTS=null;var r=g.F2A_LAST;if(!r)return "ERR\\t"+err;' +
    'return "OK\\t"+(r.comp?r.comp.name:"")+"\\t"+r.secs+"\\t"+r.log.join("\\u0001")+"\\t"+(r.mode||"new");})()';
}

function parseResult(out) {
  var p = String(out).split('\t');
  if (p[0] !== 'OK') return { ok: false, error: p.slice(1).join(' ') || String(out) };
  return { ok: !!p[1], comp: p[1], secs: parseFloat(p[2]) || 0, log: (p[3] || '').split('\u0001').filter(Boolean), mode: p[4] || 'new' };
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
  var settingsFile = opts.settingsFile;                  // tests; normally settingsDir()/settings.json
  function exportsDir(set) {
    if (opts.dir) return opts.dir;
    if (set.imagePath) return set.imagePath;
    return path.join(os.homedir(), 'Documents', 'Fig2AE');
  }
  var retryMs = opts.retryMs || 1000, waitMs = opts.waitMs || 30 * 60 * 1000;
  var queue = Promise.resolve(), seq = 0;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function run(name, body) {
    var doc = JSON.parse(body);                                  // data only, or it throws
    if (!doc || doc.app !== 'fig2ae' || !doc.comp) throw new Error('not a Fig2AE export');
    var jsx = importer.makeJsx(body, importer.runtime);
    var set = readSettings(settingsFile);
    var folder = path.join(exportsDir(set), stamp() + (++seq > 1 ? '_' + seq : ''));
    fs.mkdirSync(folder, { recursive: true });
    var file = path.join(folder, name);
    fs.writeFileSync(file, jsx, 'utf8');
    for (var waited = 0; ; waited += retryMs) {
      var out = await evalHost(importCode(file, { target: set.target, parametric: set.parametric, precompGroups: set.precompGroups }));
      if (out !== BUSY) { var r = parseResult(out); r.file = file; lastResult(r, doc); return r; }
      if (waited >= waitMs) return { ok: false, error: 'After Effects is busy (a dialog is open?) — import not done', file: file };
      await sleep(retryMs);
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
    if (req.method === 'GET') {
      // the Figma plugin asks for the panel settings before it exports (precomp groups, parametric shapes)
      send(res, 200, { ok: true, app: 'fig2ae', version: VERSION, settings: readSettings(settingsFile), update: updater.state() });
      return;
    }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return; }
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var q = /[?&]name=([^&]*)/.exec(req.url);
      var name = (q ? decodeURIComponent(q[1]) : '').replace(/[\\\/:*?"<>|]+/g, '_');
      if (!/^fig2ae_.*\.jsx$/.test(name)) name = 'fig2ae_comp.jsx';
      var body = Buffer.concat(chunks).toString('utf8');
      queue = queue.then(function () { return run(name, body); })
        .then(function (r) { send(res, 200, r); }, function (e) { send(res, 400, { ok: false, error: String(e && e.message || e) }); });
    });
  }
  // loopback only; "localhost" may resolve to either address family
  var server = http.createServer(handle);
  server.listen(opts.port === undefined ? PORT : opts.port, '127.0.0.1');
  if (opts.port === undefined) {
    http.createServer(handle).on('error', function () {}).listen(PORT, '::1');
    // auto-update: shortly after AE starts, then every 6 hours
    var auto = function () { if (readSettings(settingsFile).autoUpdate) updater.check(VERSION); };
    setTimeout(auto, 20 * 1000);
    setInterval(auto, 6 * 3600 * 1000);
  }
  return server;
}

module.exports = { start: start, importCode: importCode, parseResult: parseResult, readSettings: readSettings, writeSettings: writeSettings,
                   settingsDir: settingsDir, DEFAULTS: DEFAULTS, PORT: PORT, BUSY: BUSY, VERSION: VERSION };
