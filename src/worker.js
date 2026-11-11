// Scrim Simulator — classements en ligne (Cloudflare Worker + Durable Object SQLite)
// Aucune adresse IP n'est enregistrée : elle sert uniquement, en mémoire, à limiter les abus.
import { DurableObject } from "cloudflare:workers";

const BOARDS = {
  daily:   { max: 6000, key: /^\d{4}-\d{2}-\d{2}$/ },   // défi du jour
  seed:    { max: 6000, key: /^[a-z0-9]{4,12}$/ },      // défi entre amis
  legend:  { max: 900,  key: /^all$/ },                 // carrière joueur (score de légende)
  manager: { max: 900,  key: /^all$/ },                 // carrière manager (meilleure saison)
};
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,14}[\p{L}\p{N}]$/u;
const UID_RE = /^[a-z0-9]{16,32}$/;
const BLOCK = ['hitler','nazi','nigg','negro','negre','nègre','putain','salope','encul','pédé','pede','fdp','bougnoul','youpin','faggot','porn','couill','connard','conasse','batard','bâtard','whore','slut','cunt','fuck','shit','admin','modo','officiel'];
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const parisDay = (t) => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const cleanName = (n) => {
  if (typeof n !== 'string') return null;
  n = n.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(n)) return null;
  const low = n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const leet = low.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
  if (BLOCK.some(w => { const x = w.normalize('NFD').replace(/[̀-ͯ]/g, ''); return low.includes(x) || leet.includes(x); })) return null;
  return n;
};

// Vérification d'une clé Premium auprès du vendeur officiel (aucune clé secrète nécessaire).
async function checkLicense(env, key) {
  const prov = env.LICENSE_PROVIDER || '', now = Date.now(), cap = now + 30 * 86400000;
  const done = (ok, exp) => (ok ? { ok: true, exp: Math.min(exp || cap, cap) } : { ok: false });
  try {
    if (prov === 'lemonsqueezy') {
      const r = await fetch((env.LICENSE_API || 'https://api.lemonsqueezy.com') + '/v1/licenses/validate', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: 'license_key=' + encodeURIComponent(key) });
      const j = await r.json(), m = (j && j.meta) || {}, ex = j && j.license_key && j.license_key.expires_at;
      const ok = !!j && j.valid === true && (!env.LICENSE_STORE || String(m.store_id) === String(env.LICENSE_STORE)) && (!env.LICENSE_PRODUCT || String(m.product_id) === String(env.LICENSE_PRODUCT));
      return done(ok && (!ex || Date.parse(ex) > now), ex ? Date.parse(ex) : 0);
    }
    if (prov === 'polar') {
      const r = await fetch((env.LICENSE_API || 'https://api.polar.sh') + '/v1/customer-portal/license-keys/validate', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ key, organization_id: env.LICENSE_STORE }) });
      if (r.status === 404) return { ok: false };
      const j = await r.json(), ex = j && j.expires_at;
      const ok = !!j && j.status === 'granted' && (!env.LICENSE_PRODUCT || String(j.benefit_id) === String(env.LICENSE_PRODUCT));
      return done(ok && (!ex || Date.parse(ex) > now), ex ? Date.parse(ex) : 0);
    }
    if (prov === 'gumroad') {
      const r = await fetch((env.LICENSE_API || 'https://api.gumroad.com') + '/v2/licenses/verify', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: 'product_id=' + encodeURIComponent(env.LICENSE_PRODUCT) + '&license_key=' + encodeURIComponent(key) + '&increment_uses_count=false' });
      const j = await r.json(), pu = (j && j.purchase) || {};
      return done(!!j && j.success === true && !pu.refunded && !pu.chargebacked && !pu.disputed && !pu.subscription_ended_at && !pu.subscription_cancelled_at && !pu.subscription_failed_at, 0);
    }
  } catch (e) { return { ok: false, error: 'upstream' }; }
  return { ok: false, error: 'off' };
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.hits = new Map();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS scores(board TEXT NOT NULL, key TEXT NOT NULL, uid TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, PRIMARY KEY(board,key,uid))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS by_score ON scores(board,key,score DESC,ts ASC)`);
  }
  limited(ip, max, win) {
    const now = Date.now(), a = (this.hits.get(ip) || []).filter(t => now - t < win);
    if (a.length >= max) { this.hits.set(ip, a); return true; }
    a.push(now); this.hits.set(ip, a);
    if (this.hits.size > 5000) this.hits.clear();
    return false;
  }
  rank(board, key, uid) {
    const me = this.sql.exec('SELECT score,ts,name FROM scores WHERE board=? AND key=? AND uid=?', board, key, uid).toArray()[0];
    const ag = this.sql.exec("SELECT COUNT(*) AS n, AVG(score) AS a, SUM(CASE WHEN meta LIKE '%🏆' THEN 1 ELSE 0 END) AS c FROM scores WHERE board=? AND key=?", board, key).one();
    const total = ag.n, extra = { avg: Math.round(ag.a || 0), champs: ag.c || 0 };
    if (!me) return { total, ...extra, me: null };
    const better = this.sql.exec('SELECT COUNT(*) AS n FROM scores WHERE board=? AND key=? AND (score>? OR (score=? AND ts<?))', board, key, me.score, me.score, me.ts).one().n;
    return { total, ...extra, me: { rank: better + 1, score: me.score, name: me.name } };
  }
  top(board, key, uid, n) {
    const rows = n > 0 ? this.sql.exec('SELECT uid,name,score,meta FROM scores WHERE board=? AND key=? ORDER BY score DESC, ts ASC LIMIT ?', board, key, n).toArray() : [];
    return { top: rows.map(r => ({ name: r.name, score: r.score, meta: r.meta, me: !!uid && r.uid === uid })), ...this.rank(board, key, uid || '') };
  }
  async fetch(req) {
    const url = new URL(req.url), ip = req.headers.get('x-ip') || '?', path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/api/top') {
        if (this.limited('g' + ip, 240, 600000)) return json({ error: 'rate' }, 429);
        const board = url.searchParams.get('board') || '', key = url.searchParams.get('key') || '', uid = url.searchParams.get('uid') || '';
        const B = BOARDS[board];
        if (!B || !B.key.test(key) || (uid && !UID_RE.test(uid))) return json({ error: 'bad' }, 400);
        const n = Math.max(0, Math.min(100, parseInt(url.searchParams.get('n') || '50', 10) || 0));
        return json(this.top(board, key, uid, n));
      }
      if (req.method === 'GET' && path === '/api/week') {
        if (this.limited('g' + ip, 240, 600000)) return json({ error: 'rate' }, 429);
        const uid = url.searchParams.get('uid') || '';
        if (uid && !UID_RE.test(uid)) return json({ error: 'bad' }, 400);
        const now = Date.now(), from = parisDay(now - 6 * 86400000), to = parisDay(now);
        const rows = this.sql.exec("SELECT uid, MAX(name) AS name, SUM(score) AS score, COUNT(*) AS d FROM scores WHERE board='daily' AND key>=? AND key<=? GROUP BY uid ORDER BY score DESC, MIN(ts) ASC LIMIT 50", from, to).toArray();
        const total = this.sql.exec("SELECT COUNT(DISTINCT uid) AS n FROM scores WHERE board='daily' AND key>=? AND key<=?", from, to).one().n;
        let me = null;
        if (uid) {
          const m = this.sql.exec("SELECT MAX(name) AS name, SUM(score) AS score, COUNT(*) AS d FROM scores WHERE board='daily' AND key>=? AND key<=? AND uid=?", from, to, uid).one();
          if (m && m.d > 0) {
            const better = this.sql.exec("SELECT COUNT(*) AS n FROM (SELECT SUM(score) AS s FROM scores WHERE board='daily' AND key>=? AND key<=? GROUP BY uid) WHERE s>?", from, to, m.score).one().n;
            me = { rank: better + 1, score: m.score, name: m.name };
          }
        }
        return json({ top: rows.map(r => ({ name: r.name, score: r.score, meta: r.d + ' j', me: !!uid && r.uid === uid })), total, me });
      }
      if (req.method === 'POST' && path === '/api/license') {
        if (this.limited('l' + ip, 12, 600000)) return json({ error: 'rate' }, 429);
        const txt = await req.text();
        let b; try { b = JSON.parse(txt.slice(0, 400)); } catch (e) { return json({ error: 'bad' }, 400); }
        const key = String((b && b.key) || '').trim();
        if (!/^[A-Za-z0-9_\-]{8,90}$/.test(key)) return json({ ok: false });
        return json(await checkLicense(this.env, key));
      }
      if (req.method === 'POST' && (path === '/api/score' || path === '/api/forget')) {
        if (this.limited('p' + ip, 40, 600000)) return json({ error: 'rate' }, 429);
        const txt = await req.text();
        if (txt.length > 1200) return json({ error: 'bad' }, 400);
        let b; try { b = JSON.parse(txt); } catch (e) { return json({ error: 'bad' }, 400); }
        if (!b || typeof b !== 'object' || !UID_RE.test(b.uid || '')) return json({ error: 'bad' }, 400);
        if (path === '/api/forget') {
          this.sql.exec('DELETE FROM scores WHERE uid=?', b.uid);
          return json({ ok: true });
        }
        const B = BOARDS[b.board], key = String(b.key || '');
        if (!B || !B.key.test(key)) return json({ error: 'bad' }, 400);
        const score = Math.round(Number(b.score));
        if (!Number.isFinite(score) || score < 0 || score > B.max) return json({ error: 'score' }, 400);
        const name = cleanName(b.name);
        if (!name) return json({ error: 'name' }, 400);
        const meta = typeof b.meta === 'string' ? b.meta.slice(0, 160) : '';
        const now = Date.now();
        if (b.board === 'daily') {
          const ok = [parisDay(now - 86400000), parisDay(now), parisDay(now + 86400000)];
          if (!ok.includes(key)) return json({ error: 'day' }, 400);
        }
        if (b.board === 'seed') {
          const n = this.sql.exec('SELECT COUNT(*) AS n FROM scores WHERE board=? AND key=?', 'seed', key).one().n;
          const mine = this.sql.exec('SELECT 1 FROM scores WHERE board=? AND key=? AND uid=?', 'seed', key, b.uid).toArray().length;
          if (n >= 300 && !mine) return json({ error: 'full' }, 400);
        }
        const cur = this.sql.exec('SELECT score FROM scores WHERE board=? AND key=? AND uid=?', b.board, key, b.uid).toArray()[0];
        if (!cur) this.sql.exec('INSERT INTO scores(board,key,uid,name,score,meta,ts) VALUES(?,?,?,?,?,?,?)', b.board, key, b.uid, name, score, meta, now);
        else if (score > cur.score) this.sql.exec('UPDATE scores SET name=?,score=?,meta=?,ts=? WHERE board=? AND key=? AND uid=?', name, score, meta, now, b.board, key, b.uid);
        else this.sql.exec('UPDATE scores SET name=? WHERE board=? AND key=? AND uid=?', name, b.board, key, b.uid);
        if (Math.random() < 0.02) {
          this.sql.exec("DELETE FROM scores WHERE board='seed' AND ts<?", now - 45 * 86400000);
          this.sql.exec("DELETE FROM scores WHERE board='daily' AND ts<?", now - 200 * 86400000);
        }
        return json({ ok: true, ...this.rank(b.board, key, b.uid) });
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'server' }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const h = new Headers(request.headers);
      h.set('x-ip', request.headers.get('cf-connecting-ip') || '?');
      const stub = env.BOARD.get(env.BOARD.idFromName('global'));
      return stub.fetch(new Request(request, { headers: h }));
    }
    return env.ASSETS.fetch(request);
  },
};
