// ComicScan relay – a tiny free Cloudflare Worker run by the app's owner.
// It lets the iPhone/web app (which browsers stop from reading other sites)
// look comics up in the Grand Comics Database and read current prices from comic shops.
// App users never sign up for anything.

import { parseHTML } from 'linkedom';
import { searchAll } from './stores.js';

// Some shops write attribute names in capitals (<div Class=…>); browsers ignore case, linkedom doesn't.
const parse = html => parseHTML(String(html).replace(/(<[a-zA-Z][^>]*?\s)(Class|CLASS|ID|Id|HREF|Href|SRC|Src)=/g, (m, a, b) => a + b.toLowerCase() + '=')).document;
import * as gcd from './gcd.js';

const HOUR = 3600;
const V = 'v3:'; // bump to invalidate cached results
const UA_BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
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

async function cached(env, key0, ttl, fn) {
  const key = V + key0;
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

async function kvGet(env, key) {
  if (!env.CACHE) return null;
  try { return await env.CACHE.get((key.startsWith('upc:') ? '' : V) + key, 'json'); } catch (e) { return null; }
}
async function kvPut(env, key, val, ttl) {
  if (!env.CACHE) return;
  try { await env.CACHE.put((key.startsWith('upc:') ? '' : V) + key, JSON.stringify(val), ttl ? { expirationTtl: Math.max(60, ttl) } : undefined); } catch (e) { /* write limit */ }
}
const kvFor = env => (env.CACHE ? { get: k => kvGet(env, k), put: (k, v, ttl) => kvPut(env, k, v, ttl) } : null);

const clean = s => String(s || '').trim().slice(0, 120);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Cover images: GCD's image server refuses images embedded on other sites, so
    // pass them through here. Only comics.org cover files; cached at Cloudflare's edge.
    if (url.pathname === '/img') {
      const u = url.searchParams.get('u') || '';
      if (!/^https:\/\/files\d*\.comics\.org\/[\w\/.-]+\.(jpe?g|png|gif|webp)$/i.test(u)) return new Response('Bad image', { status: 400 });
      const r = await fetch(u, { headers: { 'User-Agent': UA_BROWSER, Referer: 'https://www.comics.org/' }, cf: { cacheTtl: 30 * 86400, cacheEverything: true } });
      if (!r.ok) return new Response('Image unavailable', { status: 502 });
      return new Response(r.body, { headers: { 'Content-Type': r.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=2592000', 'Access-Control-Allow-Origin': '*' } });
    }
    const origin = allowedOrigin(req, env);
    if (req.method === 'OPTIONS') return json({}, 204, origin);
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin);
    if (!origin) return json({ error: 'This relay only serves the ComicScan app.' }, 403, null);

    const p = url.searchParams;
    try {
      switch (url.pathname.replace(/\/+$/, '')) {
        case '':
        case '/health':
          return json({ ok: true, app: 'ComicScan relay', source: 'Grand Comics Database', cache: !!env.CACHE }, 200, origin);

        case '/api/code': {
          const code = clean(p.get('code')).replace(/\D/g, '');
          if (code.length < 10 || code.length > 18) return json({ error: 'That barcode doesn’t look right.' }, 400, origin);
          const hit = await kvGet(env, `exact:${code}`);
          if (hit) return json({ issues: [hit], exact: true }, 200, origin);
          const r = await gcd.byCode(code, kvFor(env));
          if (r.exact) await kvPut(env, `exact:${code}`, r.issues[0], 30 * 24 * HOUR);
          return json(r, 200, origin);
        }

        case '/api/identify': {
          // First scan of a new series: the user typed the series title.
          const code = clean(p.get('code')).replace(/\D/g, '');
          const series = clean(p.get('series'));
          if (!series || code.length < 10) return json({ error: 'Need the barcode and the series title.' }, 400, origin);
          const r = await gcd.searchWithCode({ series, number: clean(p.get('number')), year: +p.get('year') || null, code }, kvFor(env));
          if (r.exact) await kvPut(env, `exact:${code}`, r.issues[0], 30 * 24 * HOUR);
          return json(r, 200, origin);
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
          const stores = await cached(env, key, 2 * HOUR, () => searchAll(ctx, parse));
          return json({ stores, fetchedAt: Date.now() }, 200, origin, 30 * 60);
        }

        case '/api/debug': {
          // Shows what one shop returns to the relay (for troubleshooting).
          const { STORES } = await import('./stores.js');
          const st = STORES.find(s => s.id === p.get('store'));
          if (!st) return json({ error: 'unknown store' }, 400, origin);
          const ctx = { series: clean(p.get('series')) || 'Amazing Spider-Man', number: clean(p.get('number')) || '300', year: +p.get('year') || null };
          const url = st.searchUrl(ctx);
          const res = await fetch(url, { headers: { 'User-Agent': UA_BROWSER, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
          const html = await res.text();
          const doc = parse(html);
          return json({
            url, status: res.status, finalUrl: res.url, length: html.length,
            title: doc.querySelector('title')?.textContent?.trim() || '',
            counts: { liIssue: doc.querySelectorAll('li.issue').length, productCard: doc.querySelectorAll('div.product-card').length, item: doc.querySelectorAll('div.item').length },
            parsed: st.parse ? st.parse(doc, ctx).length : null,
            start: html.replace(/\s+/g, ' ').slice(0, 600),
          }, 200, origin);
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
