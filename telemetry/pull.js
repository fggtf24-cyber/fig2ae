/**
 * Reads the Fig2AE logs from the Worker:  node telemetry/pull.js [--all] [--errors] [--since N] [--json]
 *   the URL is in telemetry/url.txt, the read key in telemetry/.read-key (never committed).
 *   Without --since it continues after the last report it showed (telemetry/.last-id).
 * Prints a summary: versions, failed imports, the most frequent errors and warnings, then the failures in full.
 */
'use strict';
var fs = require('fs'), path = require('path'), https = require('https');
var dir = __dirname, args = process.argv.slice(2);
function opt(n) { var i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
var url = fs.readFileSync(path.join(dir, 'url.txt'), 'utf8').trim();
var key = fs.readFileSync(path.join(dir, '.read-key'), 'utf8').trim();
var lastFile = path.join(dir, '.last-id');
var since = opt('--since') !== null ? +opt('--since') : (args.indexOf('--all') >= 0 ? 0 : (+(fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8') : 0) || 0));

function get(u) {
  return new Promise(function (resolve, reject) {
    https.get(u, { headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'fig2ae-pull' } }, function (res) {
      var b = ''; res.setEncoding('utf8'); res.on('data', function (c) { b += c; });
      res.on('end', function () { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(res.statusCode + ' ' + b.slice(0, 200))); } });
    }).on('error', reject);
  });
}

(async function () {
  var all = [], id = since;
  for (;;) {
    var r = await get(url + '/v1/logs?since=' + id + (args.indexOf('--errors') >= 0 ? '&errors=1' : ''));
    if (!r.ok) throw new Error(r.error);
    all = all.concat(r.logs);
    if (r.logs.length < 500) break;
    id = r.logs[r.logs.length - 1].id;
  }
  if (args.indexOf('--json') >= 0) { console.log(JSON.stringify(all, null, 1)); }
  else {
    var ver = {}, lines = {}, installs = {}, failed = [];
    all.forEach(function (l) {
      installs[l.install] = 1;
      ver[l.version] = (ver[l.version] || 0) + 1;
      if (!l.ok && l.kind !== 'complaint') failed.push(l);
      var rep = l.report || {};
      [].concat(rep.error ? ['ERROR ' + rep.error] : [], rep.aeLog || [], rep.figmaWarnings || []).forEach(function (s) {
        var k = String(s).replace(/"[^"]*"/g, '"…"').replace(/\d+(\.\d+)?/g, 'N').slice(0, 160);
        lines[k] = (lines[k] || 0) + 1;
      });
    });
    // complaints ("Report a problem") first, in full: a user asked for these to be looked at
    var compl = all.filter(function (l) { return l.kind === 'complaint'; });
    if (compl.length) {
      console.log('=== ' + compl.length + ' COMPLAINT(S) — look at these first ===');
      compl.forEach(function (l) { console.log('\n#' + l.id + ' ' + new Date(l.t).toISOString() + ' v' + l.version + ' install ' + l.install + '\n' + JSON.stringify(l.report, null, 1)); });
      console.log('\n=== the rest ===');
    }
    console.log(all.length + ' report(s) since #' + since + ' from ' + Object.keys(installs).length + ' install(s); versions: ' + JSON.stringify(ver));
    console.log(failed.length + ' failed (complaints excluded above)');
    console.log('\nmost frequent lines:');
    Object.keys(lines).sort(function (a, b) { return lines[b] - lines[a]; }).slice(0, 40).forEach(function (k) { console.log('  ' + lines[k] + '×  ' + k); });
    if (failed.length) {
      console.log('\nfailures:');
      failed.slice(-30).forEach(function (l) { console.log('#' + l.id + ' ' + new Date(l.t).toISOString() + ' v' + l.version + ' ' + JSON.stringify(l.report).slice(0, 1500)); });
    }
  }
  if (all.length) fs.writeFileSync(lastFile, String(all[all.length - 1].id));
})().catch(function (e) { console.error('pull failed: ' + e.message); process.exit(1); });
