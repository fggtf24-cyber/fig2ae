/**
 * Anonymous logs (opt-in: the "Send anonymous logs" setting, asked once in the Figma plugin).
 * After each import one small report goes to the Fig2AE log Worker (telemetry/worker.js):
 * versions, OS, settings, time, how many layers, the errors and warnings of that import.
 * Never: the design itself, pictures, file contents, file or folder paths (they are cut out of every line).
 * Layer and font names can be in the warnings — the consent text says so.
 */
'use strict';
var https = require('https'), os = require('os');

var ENDPOINT = 'https://fig2ae-logs.webja.workers.dev/v1/log';   // telemetry/url.txt (the Worker, see telemetry/worker.js)

/** file paths out of a line: C:\…, \\server\…, /Users/…, /Volumes/…, ~/… */
function scrub(s) {
  return String(s)
    .replace(/[A-Za-z]:[\\/][^"'|<>\r\n]*/g, '<path>')
    .replace(/\\\\[^\\\s"']+\\[^"'|<>\r\n]*/g, '<path>')
    .replace(/(^|[\s"'(])(\/(Users|Volumes|home|private|var|tmp)\/[^"'|<>\r\n]*)/g, '$1<path>')
    .replace(/~\/[^"'|<>\r\n]*/g, '<path>')
    .slice(0, 600);
}
function lines(a, max) { return (a || []).slice(0, max || 60).map(scrub); }

/** settings without anything personal (the picture folder) */
function cleanSettings(set) {
  var out = {};
  for (var k in set) if (k !== 'imagePath' && k !== 'installId') out[k] = set[k];
  out.customImagePath = !!set.imagePath;
  return out;
}

function countLayers(ls) {
  var n = 0;
  (function walk(a) { for (var i = 0; i < (a || []).length; i++) { var l = a[i]; if (!l) continue; n++; if (l.comp) walk(l.comp.layers); if (l.matte && l.matte.layer) walk([l.matte.layer]); } })(ls);
  return n;
}

/** fire and forget: never throws, never waits more than 8 s, nothing if not allowed or not configured */
function send(report, set, force) {
  try {
    // force: the user pressed "Report a problem" — this one report goes even with the logs switched off
    if (!set || (set.sendLogs !== true && !force) || !set.installId || /REPLACE/.test(ENDPOINT)) return Promise.resolve(false);
    var body = JSON.stringify(report);
    if (body.length > 60000) { report.aeLog = (report.aeLog || []).slice(0, 15); report.figmaWarnings = (report.figmaWarnings || []).slice(0, 15); report.raw = undefined; body = JSON.stringify(report); }
    return new Promise(function (resolve) {
      var u = new URL(ENDPOINT);
      var req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 8000,
                                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function (res) {
        res.resume(); res.on('end', function () { resolve(res.statusCode === 200); });
      });
      req.on('timeout', function () { req.destroy(); resolve(false); });
      req.on('error', function () { resolve(false); });
      req.end(body);
    });
  } catch (e) { return Promise.resolve(false); }
}

/** the report of one import (r: parsed result from the importer, doc: the export, set: settings) */
function importReport(version, set, r, doc, raw) {
  return {
    app: 'fig2ae', kind: 'import', install: set.installId, version: version,
    os: process.platform + ' ' + os.release(), node: process.version,
    settings: cleanSettings(set),
    ok: !!r.ok, cancelled: !!r.cancelled, mode: r.mode || '', secs: r.secs || 0,
    error: r.error ? scrub(r.error) : undefined,
    layers: doc && doc.comp ? countLayers(doc.comp.layers) : 0,
    update: !!(doc && doc.update), stats: doc && doc.stats ? doc.stats : undefined,
    aeLog: lines(r.log), figmaWarnings: lines(doc && doc.warnings),
    raw: r.ok || r.cancelled ? undefined : scrub(String(raw || '').slice(0, 1500))
  };
}

/** "Report a problem": the user's note, the last import, the recent events of both sides — marked for a look first */
function complaint(version, set, note, figmaLog, serverLog, last) {
  return {
    app: 'fig2ae', kind: 'complaint', priority: 1, install: set.installId, version: version,
    os: process.platform + ' ' + os.release(), node: process.version, settings: cleanSettings(set),
    ok: false, note: scrub(String(note || '').slice(0, 2000)),
    last: last ? { ok: last.ok, mode: last.mode, secs: last.secs, error: last.error ? scrub(last.error) : undefined, log: lines(last.log) } : undefined,
    serverLog: (serverLog || []).slice(-60).map(function (e) { return scrub(e.t + ' ' + e.kind + ' ' + e.msg + (e.data ? ' ' + JSON.stringify(e.data) : '')); }),
    figmaLog: lines(figmaLog, 60)
  };
}

module.exports = { send: send, importReport: importReport, complaint: complaint, scrub: scrub, endpoint: function () { return ENDPOINT; } };
