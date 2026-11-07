/**
 * node test/server.test.js
 * cep/server.js with a fake AE: the export lands in its own folder, AE busy with
 * a modal dialog is waited out, the import result goes back to the Figma plugin.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var srv = require('../cep/server.js');

// an export with a Figma background blur: its mask layer sits in .matte itself, not in .matte.layer
(function () {
  var rt = require('../cep/runtime.js');
  var shape = { type: 'shape', name: 'Header · blur mask', groups: [] };
  var pic = { type: 'image', name: 'pic', png: { b64: 'AAAA', ext: 'png' } };
  var doc = { app: 'fig2ae', v: 3, comp: { name: 'c', w: 10, h: 10, layers: [
    { type: 'bgblur', name: 'Header · background blur', sigma: 4, matte: shape }, pic,
    { type: 'precomp', name: 'p', comp: { name: 'p', w: 5, h: 5, layers: [{ type: 'bgblur', name: 'b', sigma: 1, matte: shape }] } }] }, warnings: [] };
  var jsx = rt.makeJsx(JSON.stringify(doc), rt.runtime);
  assert.ok(jsx.indexOf('F2A-PAYLOAD-END') > 0 && jsx.indexOf('"ref":0') > 0, 'экспорт с background blur собирается');
})();

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fig2ae-srv-'));
var calls = [];
var server = srv.start(function (code) {
  calls.push(code);
  // first call: a modal dialog is open in AE
  return Promise.resolve(calls.length === 1 ? srv.BUSY : 'OK\tКомпозиция\t1.5\tпервое\u0001второе');
}, { port: 0, dir: dir, retryMs: 10 });

server.on('listening', function () {
  var port = server.address().port;
  var body = JSON.stringify({ app: 'fig2ae', v: 3, comp: { name: 'Карточка', w: 10, h: 10, layers: [] }, warnings: [] });
  var req = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: '/import?name=' + encodeURIComponent('fig2ae_Карточка.jsx'),
                           headers: { 'Content-Type': 'text/plain;charset=utf-8' } }, function (res) {
    var data = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { data += c; });
    res.on('end', function () {
      try {
        assert.strictEqual(res.headers['access-control-allow-origin'], '*');
        var r = JSON.parse(data);
        assert.strictEqual(r.ok, true, data);
        assert.strictEqual(r.comp, 'Композиция');
        assert.deepStrictEqual(r.log, ['первое', 'второе']);
        assert.strictEqual(calls.length, 2, 'занятый AE должен переспрашиваться');
        assert.strictEqual(path.basename(r.file), 'fig2ae_Карточка.jsx');
        assert.strictEqual(path.dirname(path.dirname(r.file)), dir, 'каждый экспорт — в своей папке');
        var jsx = fs.readFileSync(r.file, 'utf8');
        assert.ok(jsx.indexOf('﻿// Fig2AE') === 0 && jsx.indexOf('var F2A_DATA = ') > 0 && jsx.indexOf('F2A-PAYLOAD-END') > 0, 'сервер сам собирает .jsx из данных');
        assert.ok(calls[1].indexOf(JSON.stringify(r.file.split(path.sep).join('/'))) > 0, 'AE получает путь к файлу');
        assert.deepStrictEqual(srv.parseResult('ERR\tboom'), { ok: false, error: 'boom' });
        var cr = srv.parseResult('OK\t\t0.5\t\tcancelled');
        assert.ok(!cr.ok && cr.cancelled && /cancelled/.test(cr.error), 'отменённый импорт — не ошибка, а отмена');
        rejectCode(port, function () { noCancel(port, function () {
          console.log('server: all checks passed');
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        }); });
        return;
      } catch (e) { console.error(e); process.exitCode = 1; }
      server.close();
    });
  });
  req.end(body);
});

// Stop / Cancel with no import running: nothing to do, nothing written
function noCancel(port, done) {
  var req = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: '/cancel?how=cancel' }, function (res) {
    var data = '';
    res.on('data', function (c) { data += c; });
    res.on('end', function () {
      try { assert.strictEqual(JSON.parse(data).ok, false, data); } catch (e) { console.error(e); process.exitCode = 1; }
      done();
    });
  });
  req.end();
}

// code instead of data (any web page can POST to localhost) is refused and never reaches AE
function rejectCode(port, done) {
  var n = calls.length;
  var req = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: '/import?name=fig2ae_x.jsx' }, function (res) {
    res.resume();
    res.on('end', function () {
      try { assert.strictEqual(res.statusCode, 400); assert.strictEqual(calls.length, n, 'чужой код не должен попасть в AE'); }
      catch (e) { console.error(e); process.exitCode = 1; }
      done();
    });
  });
  req.end('app.project.close(); system.callSystem("calc");');
}
