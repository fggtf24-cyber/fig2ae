/**
 * Fig2AE logs — a Cloudflare Worker (D1 database "LOGS").
 *
 *   POST /v1/log           a Fig2AE install sends one report (JSON, ≤ 64 KB) — only when its user said yes
 *   GET  /v1/logs?since=N  reports newer than id N (oldest first, ≤ 500) — needs  Authorization: Bearer <READ_KEY>
 *   GET  /v1/stats         counts per version / per error line — same key
 *
 * Reports older than 90 days are deleted on the daily cron.
 */
const MAX = 64 * 1024;
const KEEP_DAYS = 90;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function authorized(req, env) {
  const h = req.headers.get('Authorization') || '';
  return !!env.READ_KEY && h === 'Bearer ' + env.READ_KEY;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/v1/log') {
      const len = +(req.headers.get('Content-Length') || 0);
      if (len > MAX) return json({ ok: false, error: 'too big' }, 413);
      const text = await req.text();
      if (text.length > MAX) return json({ ok: false, error: 'too big' }, 413);
      let r;
      try { r = JSON.parse(text); } catch (e) { return json({ ok: false, error: 'not json' }, 400); }
      if (!r || r.app !== 'fig2ae' || typeof r.install !== 'string' || r.install.length > 64) return json({ ok: false, error: 'not a Fig2AE report' }, 400);
      await env.LOGS.prepare('INSERT INTO logs (t, install, version, kind, ok, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(Date.now(), r.install, String(r.version || '').slice(0, 20), String(r.kind || '').slice(0, 20), r.ok === false ? 0 : 1, text)
        .run();
      return json({ ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/v1/logs') {
      if (!authorized(req, env)) return json({ ok: false, error: 'key' }, 401);
      const since = +(url.searchParams.get('since') || 0);
      const onlyErrors = url.searchParams.get('errors') === '1';
      const kind = url.searchParams.get('kind');          // "complaint": the reports users sent with "Report a problem"
      let q = 'SELECT id, t, install, version, kind, ok, body FROM logs WHERE id > ?1';
      if (onlyErrors) q += ' AND ok = 0';
      if (kind) q += ' AND kind = ?2';
      q += ' ORDER BY id LIMIT 500';
      const st = env.LOGS.prepare(q);
      const { results } = await (kind ? st.bind(since, kind) : st.bind(since)).all();
      return json({ ok: true, logs: results.map(function (row) { let b = null; try { b = JSON.parse(row.body); } catch (e) {} return { id: row.id, t: row.t, install: row.install, version: row.version, kind: row.kind, ok: !!row.ok, report: b }; }) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/stats') {
      if (!authorized(req, env)) return json({ ok: false, error: 'key' }, 401);
      const v = await env.LOGS.prepare('SELECT version, COUNT(*) AS n, SUM(1 - ok) AS failed, COUNT(DISTINCT install) AS installs FROM logs GROUP BY version ORDER BY version DESC').all();
      return json({ ok: true, versions: v.results });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  async scheduled(event, env) {
    await env.LOGS.prepare('DELETE FROM logs WHERE t < ?1').bind(Date.now() - KEEP_DAYS * 86400000).run();
  }
};
