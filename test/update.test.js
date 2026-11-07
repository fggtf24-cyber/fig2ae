/**
 * node test/update.test.js
 * cep/updater.js against a fake GitHub: an older install gets the new Fig2AE.zip
 * copied over (extension + Figma plugin); an incomplete archive changes nothing.
 */
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), https = require('https'), cp = require('child_process');
var ROOT = path.join(__dirname, '..');
var zip = path.join(ROOT, 'Fig2AE.zip');
if (!fs.existsSync(zip)) cp.execFileSync(process.execPath, [path.join(ROOT, 'make-release.js')]);

var home = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-upd-'));
process.env.HOME = home; process.env.APPDATA = path.join(home, 'Roaming');
var cfg = process.platform === 'win32' ? path.join(home, 'Roaming', 'Fig2AE') : path.join(home, 'Library', 'Application Support', 'Fig2AE');
var cepDir = path.join(home, 'cep'), plugin = path.join(home, 'figma-plugin');
fs.mkdirSync(cfg, { recursive: true }); fs.mkdirSync(cepDir); fs.mkdirSync(plugin);
fs.writeFileSync(path.join(cepDir, 'server.js'), 'old');
fs.writeFileSync(path.join(plugin, 'code.js'), 'old');
fs.writeFileSync(path.join(cfg, 'install.json'), '﻿' + JSON.stringify({ figmaPlugin: plugin }));

var served = { 'version.txt': '9.9.9\n', 'Fig2AE.zip': fs.readFileSync(zip) };
https.get = function (url, opts, cb) {
  var name = String(url).split('?')[0].split('/').pop();
  var res = new (require('stream').PassThrough)();
  res.statusCode = served[name] ? 200 : 404; res.headers = {};
  res.setEncoding = function () {};
  setImmediate(function () { cb(res); res.end(served[name] || ''); });
  return { setTimeout: function () {}, on: function () { return this; }, destroy: function () {} };
};

var U = require(path.join(ROOT, 'cep', 'updater.js'));
U.check('0.0.1', { cepDir: cepDir }).then(function (s) {
  assert.strictEqual(s.status, 'installed', JSON.stringify(s));
  assert.strictEqual(s.restart, true, 'у старой копии не было manifest.xml — нужен перезапуск AE');
  assert.notStrictEqual(fs.readFileSync(path.join(cepDir, 'server.js'), 'utf8'), 'old', 'расширение обновлено');
  assert.ok(fs.existsSync(path.join(cepDir, 'panel', 'host.jsx')));
  assert.notStrictEqual(fs.readFileSync(path.join(plugin, 'code.js'), 'utf8'), 'old', 'плагин Figma обновлён');
  // the next check before the restart must not forget that a restart is needed
  return U.check('0.0.1', { cepDir: cepDir });
}).then(function (s) {
  assert.strictEqual(s.status, 'installed');
  assert.strictEqual(s.restart, true, 'повторная проверка не теряет «нужен перезапуск»');
  // same manifest (only versions differ): applied live, no AE restart
  served['version.txt'] = '9.9.10';
  return U.check('9.9.9', { cepDir: cepDir });
}).then(function (s) {
  assert.strictEqual(s.status, 'installed'); assert.strictEqual(s.restart, false, 'манифест тот же — обновление без перезапуска');
  return U.check('9.9.10', { cepDir: cepDir });
}).then(function (s) {
  assert.strictEqual(s.status, 'latest');
  // a broken archive: nothing is touched
  fs.writeFileSync(path.join(cepDir, 'server.js'), 'mine');
  served['version.txt'] = '10.0.0';
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-bad-'));
  fs.mkdirSync(path.join(tmp, 'cep', 'CSXS'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'cep', 'CSXS', 'manifest.xml'), 'x');
  if (process.platform === 'win32') {
    cp.execFileSync('powershell', ['-NoProfile', '-Command', "Compress-Archive -Path '" + path.join(tmp, 'cep') + "' -DestinationPath '" + path.join(tmp, 'bad.zip') + "'"]);
  } else cp.execFileSync('zip', ['-qr', path.join(tmp, 'bad.zip'), 'cep'], { cwd: tmp });
  served['Fig2AE.zip'] = fs.readFileSync(path.join(tmp, 'bad.zip'));
  return U.check('9.9.10', { cepDir: cepDir });
}).then(function (s) {
  assert.strictEqual(s.status, 'error');
  assert.ok(/incomplete/.test(s.error), s.error);
  assert.strictEqual(fs.readFileSync(path.join(cepDir, 'server.js'), 'utf8'), 'mine', 'неполный архив ничего не трогает');
  fs.rmSync(home, { recursive: true, force: true });
  console.log('update: all checks passed');
}).catch(function (e) { console.error(e); process.exit(1); });
