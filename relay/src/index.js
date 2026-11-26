// ComicScan relay – a tiny free Cloudflare Worker run by the app's owner.
// It lets the iPhone/web app (which browsers stop from reading other sites)
// look comics up in the Grand Comics Database and read current prices from comic shops.
// App users never sign up for anything.

import { parseHTML } from 'linkedom';
import { searchAll } from './stores.js';
import * as gcd from './gcd.js';

const HOUR = 3600;
const mem = new Map(); // per-isolate cache

function allowedOrigin(req, env) {
  const origin = req.headers.get('Origin');
  const list = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin) return list.includes('*') ? '*' : list[0];
  if (list.includes('*') || list.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function json(data, status, origin, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin || 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

async function cached(env, key, ttl, fn) {
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  if (env.CACHE) {
    try {
      const v = await env.CACHE.get(key, 'json');
      if (v) { mem.set(key, { val: v, exp: Date.now() + 5 * 60e3 }); return v; }
    } catch (e) { /* KV unavailable */ }
  }
  const val = await fn();
  mem.set(key, { val, exp: Date.now() + Math.min(ttl, 3600) * 1000 });
  if (mem.size > 500) mem.delete(mem.keys().next().value);
  if (env.CACHE) {
    try { await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: Math.max(60, ttl) }); } catch (e) { /* daily write limit */ }
  }
  return val;
}

const clean = s => String(s || '').trim().slice(0, 120);

export default {
  async fetch(req, env) {
    const origin = allowedOrigin(req, env);
    if (req.method === 'OPTIONS') return json({}, 204, origin);
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin);
    if (!origin) return json({ error: 'This relay only serves the ComicScan app.' }, 403, null);

    const url = new URL(req.url);
    const p = url.searchParams;
    try {
      switch (url.pathname.replace(/\/+$/, '')) {
        case '':
        case '/health':
          return json({ ok: true, app: 'ComicScan relay', source: 'Grand Comics Database', cache: !!env.CACHE }, 200, origin);

        case '/api/code': {
          const code = clean(p.get('code')).replace(/\D/g, '');
          if (code.length < 10 || code.length > 18) return json({ error: 'That barcode doesn’t look right.' }, 400, origin);
          const issues = await cached(env, `code:${code}`, 7 * 24 * HOUR, () => gcd.byCode(code));
          return json({ issues }, 200, origin, HOUR);
        }

        case '/api/search': {
          const series = clean(p.get('series'));
          if (!series) return json({ error: 'Type a series name.' }, 400, origin);
          const number = clean(p.get('number'));
          const year = +p.get('year') || null;
          const issues = await cached(env, `search:${series.toLowerCase()}|${number}|${year || ''}`, 7 * 24 * HOUR,
            () => gcd.search({ series, number, year }));
          return json({ issues }, 200, origin, HOUR);
        }

        case '/api/issue': {
          const id = +p.get('id');
          if (!id) return json({ error: 'Missing issue id.' }, 400, origin);
          const issue = await cached(env, `issue:${id}`, 14 * 24 * HOUR, () => gcd.issue(id));
          if (!issue) return json({ error: 'Issue not found.' }, 404, origin);
          return json({ issue }, 200, origin, 6 * HOUR);
        }

        case '/api/prices': {
          const ctx = {
            series: clean(p.get('series')),
            number: clean(p.get('number')) || null,
            year: +p.get('year') || null,
            volume: +p.get('volume') || null,
            trade: p.get('trade') === '1',
          };
          if (!ctx.series) return json({ error: 'Missing series.' }, 400, origin);
          const key = `prices:${ctx.series.toLowerCase()}|${ctx.number}|${ctx.year}|${ctx.volume}|${ctx.trade ? 1 : 0}`;
          const stores = await cached(env, key, 2 * HOUR, () => searchAll(ctx, html => parseHTML(html).document));
          return json({ stores, fetchedAt: Date.now() }, 200, origin, 30 * 60);
        }

        default:
          return json({ error: 'Not found' }, 404, origin);
      }
    } catch (e) {
      const status = e instanceof gcd.GcdError ? e.status : 500;
      return json({ error: e.message || 'Relay error' }, status, origin);
    }
  },
};
