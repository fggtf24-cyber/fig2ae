/**
 * Fig2AE panel (Window > Extensions > Fig2AE) — the AEUX-style panel.
 * Settings go to <AppData>/Fig2AE/settings.json (server.js reads them on every
 * import and hands them to the Figma plugin) and to app.settings (file imports).
 * GROUPS tools run in ExtendScript: host.jsx.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var hasNode = typeof require === 'function';
  var cep = window.__adobe_cep__;
  var dir = decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, '$1');
  dir = dir.slice(0, dir.lastIndexOf('/'));

  var S, U, fs, path, os;
  if (hasNode) {
    S = require(dir + '/../server.js');
    U = require(dir + '/../updater.js');
    fs = require('fs'); path = require('path'); os = require('os');
  } else {
    // browser preview without After Effects
    var mem = { target: 'new', imagePath: '', parametric: false, precompGroups: false, groupNulls: true, autoUpdate: true };
    U = { state: function () { return {}; }, check: function () { return Promise.resolve({ status: 'error', error: 'preview' }); } };
    S = { readSettings: function () { return mem; }, writeSettings: function (o) { for (var k in o) mem[k] = o[k]; return mem; },
          settingsDir: function () { return ''; }, VERSION: '0.4.0' };
  }

  function evalHost(code) {
    return new Promise(function (resolve) {
      if (!cep) return resolve('ERR\tAfter Effects is not connected (preview)');
      cep.evalScript(code, resolve);
    });
  }
  function host(fn, arg) {
    // loads host.jsx when it is not there yet (the panel may have opened while an AE dialog blocked scripts)
    var load = 'if (typeof F2A_HOST === "undefined") $.evalFile(' + JSON.stringify(dir + '/host.jsx') + ');';
    return evalHost(load + 'F2A_HOST.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')').then(function (r) {
      var s = String(r), i = s.indexOf('\t');
      if (s === 'EvalScript error.') return { ok: false, msg: 'After Effects is busy (a dialog is open?)' };
      return { ok: s.slice(0, i) === 'OK', msg: i >= 0 ? s.slice(i + 1) : s };
    });
  }
  evalHost('$.evalFile(' + JSON.stringify(dir + '/host.jsx') + ')');

  /* ---------------------------------------------------------- settings */
  var set = S.readSettings();
  function defaultPath() { return hasNode ? path.join(os.homedir(), 'Documents', 'Fig2AE') : 'Documents/Fig2AE'; }
  function save(patch) {
    set = S.writeSettings(patch);
    host('saveOpts', JSON.stringify(set));
    render();
  }
  function render() {
    $('tNew').className = set.target === 'current' ? '' : 'on';
    $('tCur').className = set.target === 'current' ? 'on' : '';
    var p = $('pathText');
    p.textContent = set.imagePath || defaultPath();
    p.className = set.imagePath ? '' : 'def';
    p.title = p.textContent;
    var cs = document.querySelectorAll('.check');
    for (var i = 0; i < cs.length; i++) {
      var k = cs[i].getAttribute('data-opt');
      cs[i].className = 'check' + (k === 'groupNulls' ? ' sub' + (set.precompGroups ? ' off' : '') : '') + (set[k] ? ' on' : '');
    }
  }

  $('tNew').onclick = function () { save({ target: 'new' }); };
  $('tCur').onclick = function () { save({ target: 'current' }); };
  // Windows: the normal Explorer folder dialog (pickfolder.ps1); macOS / fallback: ExtendScript's dialog (Finder there)
  function explorerPick(start) {
    return new Promise(function (resolve, reject) {
      if (!hasNode || process.platform !== 'win32') return reject();
      require('child_process').execFile('powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'pickfolder.ps1'), '-Start', start],
        { windowsHide: true }, function (e, out) {
          if (e) return reject(e);
          resolve(Buffer.from(String(out).trim(), 'base64').toString('utf8'));
        });
    });
  }
  $('pathPick').onclick = function () {
    var start = set.imagePath || defaultPath();
    explorerPick(start).then(function (p) { if (p) save({ imagePath: p }); }, function () {
      host('pickFolder', start).then(function (r) { if (r.ok && r.msg) save({ imagePath: r.msg }); });
    });
  };
  $('pathClear').onclick = function () { save({ imagePath: '' }); };
  Array.prototype.forEach.call(document.querySelectorAll('.check'), function (el) {
    el.onclick = function () { var k = el.getAttribute('data-opt'), o = {}; o[k] = !set[k]; save(o); };
  });

  /* ---------------------------------------------------------- sections */
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  Array.prototype.forEach.call(document.querySelectorAll('section'), function (s) {
    var k = 'fig2ae.sec.' + s.id, v = store(k);
    if (v === '1') s.classList.add('closed'); else if (v === '0') s.classList.remove('closed');
    s.querySelector('.sec-h').onclick = function () { s.classList.toggle('closed'); store(k, s.classList.contains('closed') ? '1' : '0'); };
  });

  /* ---------------------------------------------------------- actions */
  var toastT;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg; t.title = msg; t.className = kind || '';
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.textContent = ''; t.className = ''; }, 6000);
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-host]'), function (b) {
    b.onclick = function () { host(b.getAttribute('data-host')).then(function (r) { toast(r.msg, r.ok ? 'ok' : 'err'); }); };
  });

  var CMD = {
    importFile: function () {
      host('importFile', JSON.stringify(set)).then(function (r) {
        if (!r.msg) return;
        var lines = r.msg.split('\n');
        toast((r.ok ? '✓ ' : '') + lines[0], r.ok ? 'ok' : 'err');
        if (r.ok) showWarnings(lines.slice(1));
      });
    },
    openFolder: function () { host('openFolder', set.imagePath || defaultPath()); },
    reload: function () { location.reload(); }
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-cmd]'), function (b) {
    b.onclick = function () { $('menu').classList.remove('open'); CMD[b.getAttribute('data-cmd')](); };
  });
  $('menuBtn').onclick = function (e) { e.stopPropagation(); $('menu').classList.toggle('open'); };
  document.addEventListener('click', function (e) { if (!$('menu').contains(e.target)) $('menu').classList.remove('open'); });

  /* ---------------------------------------------------------- system */
  function showUpdate(u) {
    u = u || {};
    var t = 'v' + S.VERSION, b = 'Check for updates';
    if (u.status === 'installed') { t += ' → v' + u.latest + ' installed'; b = 'Restart After Effects to finish'; }
    else if (u.status === 'available') { t += ' · v' + u.latest + ' available'; b = 'Install v' + u.latest; }
    else if (u.status === 'latest') t += ' · up to date';
    else if (u.status === 'error') t += ' · update check failed';
    $('updText').textContent = t;
    $('updText').title = u.error || u.notes || '';
    $('updBtnText').textContent = b;
  }
  showUpdate(U.state());
  $('updBtn').onclick = function () {
    $('updBtnText').textContent = 'Checking…';
    U.check(S.VERSION).then(function (u) {
      showUpdate(u);
      toast(u.status === 'installed' ? 'v' + u.latest + ' installed — restart After Effects' :
            u.status === 'latest' ? 'Fig2AE is up to date' : u.status === 'error' ? 'Update failed: ' + u.error : '',
            u.status === 'error' ? 'err' : 'ok');
    });
  };
  setInterval(function () { showUpdate(U.state()); }, 10000);
  function showWarnings(list) {
    var w = $('warns');
    w.innerHTML = '';
    (list || []).forEach(function (t) { var d = document.createElement('div'); d.textContent = t; w.appendChild(d); });
  }
  function ping() {
    fetch('http://127.0.0.1:7251/').then(function (r) { return r.json(); }).then(function () {
      $('srvDot').className = 'dot on'; $('srvText').textContent = 'listening on :7251';
    }, function () {
      $('srvDot').className = 'dot off'; $('srvText').textContent = 'not running';
    });
  }
  ping(); setInterval(ping, 5000);

  // the hidden server writes last.json after every import from Figma
  var lastSeen = 0, first = true;
  function poll() {
    if (!hasNode) return;
    var f = path.join(S.settingsDir(), 'last.json'), st;
    try { st = fs.statSync(f); } catch (e) { return; }
    if (st.mtimeMs === lastSeen) return;
    lastSeen = st.mtimeMs;
    var r;
    try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
    var when = new Date(r.time), hh = ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2);
    $('lastText').textContent = r.ok ? '"' + r.comp + '" · ' + hh : 'failed · ' + hh;
    $('lastText').title = r.ok ? r.comp + ' (' + (r.mode === 'current' ? 'into current comp' : 'new comp') + ', ' + r.secs.toFixed(1) + ' s)' : r.error;
    showWarnings(r.log);
    if (!first) toast(r.ok ? '✓ "' + r.comp + '" imported' + (r.log.length ? ' · ' + r.log.length + ' warning(s) in System' : '')
                           : 'Import failed: ' + r.error, r.ok ? 'ok' : 'err');
    first = false;
  }
  poll(); setInterval(poll, 1500);

  render();
})();
