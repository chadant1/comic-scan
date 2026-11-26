// Grand Comics Database (https://www.comics.org) – open comic data (CC BY-SA 4.0).
//  • Issue details and title search come from GCD's public data API (no login).
//  • Barcode → issue: each series' UPC is learned once (see byCode/searchWithCode).

const GCD = 'https://www.comics.org';
const UA = 'ComicScanRelay/1.0 (+https://github.com/chadant1/comic-scan)';

export class GcdError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// GCD allows only about 20 API requests a minute. When it says "slow down", stop
// asking for a minute (shared across the relay through KV) instead of piling on.
let coolUntil = 0;
let coolKv = null;
let auth = null;
export const status = { last: null, at: null, retryAfter: null, signedIn: false };
/** kv for the shared cooldown; login = "email:password" from the GCD_LOGIN secret (optional). */
export function useKv(kv, login) {
  coolKv = kv;
  auth = login && login.includes(':') ? 'Basic ' + btoa(unescape(encodeURIComponent(login.trim()))) : null;
  status.signedIn = !!auth;
}
const COOL = 'gcd:cooldown';

async function api(path) {
  if (Date.now() < coolUntil) throw new GcdError('The comic database is busy. Try again in a minute.', 429);
  if (coolKv && !coolUntil) {
    const t = await coolKv.get(COOL).catch(() => null);
    if (t && Date.now() < t) { coolUntil = t; throw new GcdError('The comic database is busy. Try again in a minute.', 429); }
  }
  const url = path.startsWith('http') ? path : GCD + path;
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'format=json', {
    headers: { Accept: 'application/json', 'User-Agent': UA, ...(auth ? { Authorization: auth } : {}) },
    signal: AbortSignal.timeout(25000),
  });
  status.last = res.status; status.at = new Date().toISOString(); status.retryAfter = res.headers.get('retry-after');
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    if (auth) throw new GcdError('The relay’s GCD sign-in was refused. Check the GCD_LOGIN secret.', 502);
  }
  if (res.status === 429) {
    const wait = Math.min(3600, Math.max(60, +res.headers.get('retry-after') || 60));
    coolUntil = Date.now() + wait * 1000;
    if (coolKv) await coolKv.put(COOL, coolUntil, wait).catch(() => {});
    throw new GcdError(wait > 120 ? `The comic database has hit its hourly limit. Try again in about ${Math.ceil(wait / 60)} minutes.` : 'The comic database is busy. Try again in a minute.', 429);
  }
  coolUntil = 0;
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('json')) throw new GcdError(`The comic database didn’t answer (${res.status}).`, 502);
  return res.json();
}

const idOf = url => +(/\/(\d+)\/?(?:\?|$)/.exec(String(url || ''))?.[1] || 0) || null;

/** "Absolute Batman (2024 series)" -> { name: "Absolute Batman", year: 2024 } */
export function splitSeries(s) {
  const m = /^(.*?)\s*\((\d{4})\s+series\)\s*$/.exec(String(s || ''));
  return m ? { name: m[1], year: +m[2] } : { name: String(s || ''), year: null };
}

const clean = s => String(s || '')
  .replace(/\s*\((?:credited|signed|signed as[^)]*|painted|uncredited|typeset|as [^)]*)\)/gi, '')
  .replace(/\?/g, '')
  .trim();
const people = s => String(s || '')
  .split(';')
  .map(x => clean(x).replace(/\s*\[.*?\]\s*/g, ' ').trim())
  .filter(x => x && !/^none$/i.test(x) && !/^\(?typeset\)?$/i.test(x));
const chars = s => String(s || '')
  .replace(/\b(?:Villains?|Guest stars?|Supporting characters?|Antagonists?|Cameos?)\s*:/gi, ';')
  .split(/[;,]/)
  .map(x => x.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim())
  .filter(x => x && x.length < 60);

const pubCache = new Map();
async function publisherName(url) {
  const id = idOf(url);
  if (!id) return null;
  if (pubCache.has(id)) return pubCache.get(id);
  const p = await api(`/api/publisher/${id}/`).catch(() => null);
  const name = p?.name || null;
  pubCache.set(id, name);
  return name;
}

const seriesCache = new Map();
async function series(url) {
  const id = idOf(url);
  if (!id) return null;
  if (seriesCache.has(id)) return seriesCache.get(id);
  const s = await api(`/api/series/${id}/`).catch(() => null);
  const out = s ? { id, name: s.name, year: s.year_began || null, format: s.publishing_format || null, publisher: await publisherName(s.publisher) } : null;
  seriesCache.set(id, out);
  return out;
}

/** Full details for one issue, shaped for the app. */
export async function issue(id) {
  const d = await api(`/api/issue/${encodeURIComponent(id)}/`);
  if (!d) return null;
  // The series/publisher endpoints are slow (up to ~10 s), so only use them
  // briefly; the issue itself already carries the series name, year and indicia publisher.
  const s = await Promise.race([series(d.series), new Promise(r => setTimeout(() => r(null), 3500))]);
  const sn = splitSeries(d.series_name);
  const credits = new Map();
  const add = (role, names) => { for (const n of names) { if (!credits.has(n)) credits.set(n, new Set()); credits.get(n).add(role); } };
  const characters = [];
  const stories = [];
  let synopsis = '';
  for (const st of d.story_set || []) {
    const cover = st.type === 'cover';
    add(cover ? 'Cover' : 'Writer', people(st.script));
    add(cover ? 'Cover' : 'Penciller', people(st.pencils));
    add(cover ? 'Cover' : 'Inker', people(st.inks));
    if (!cover) { add('Colorist', people(st.colors)); add('Letterer', people(st.letters)); }
    add('Editor', people(st.editing));
    if (!cover) {
      for (const c of chars(st.characters)) if (!characters.includes(c)) characters.push(c);
      if (st.title) stories.push(st.title.replace(/^\[|\]$/g, ''));
      if (!synopsis && st.synopsis) synopsis = st.synopsis;
    }
  }
  const price = /([\d.]+)\s*USD/.exec(d.price || '')?.[1] || (/^[\d.]+/.exec(d.price || '')?.[0] ?? null);
  const keyDate = String(d.key_date || '').replace(/-00$/, '-01').replace(/-00-01$/, '-01-01');
  return {
    id: +id,
    series: s?.name || sn.name,
    seriesId: s?.id || idOf(d.series),
    year: s?.year || sn.year,
    seriesType: s?.format || null,
    number: d.number || d.descriptor || '',
    variant: d.variant_name || null,
    isVariant: !!d.variant_of,
    title: d.title || null,
    stories: stories.slice(0, 8),
    publisher: s?.publisher || d.indicia_publisher || null,
    brand: d.brand_emblem || null,
    coverDate: keyDate || null,
    publicationDate: d.publication_date || null,
    storeDate: d.on_sale_date ? String(d.on_sale_date).replace(/-00$/, '-01') : null,
    price,
    rating: d.rating || null,
    pages: d.page_count ? Math.round(parseFloat(d.page_count)) : null,
    upc: d.barcode || null,
    isbn: d.isbn || null,
    desc: synopsis || null,
    notes: d.notes || null,
    image: d.cover || null,
    arcs: [],
    characters: characters.slice(0, 40),
    teams: [],
    credits: [...credits.entries()].map(([name, roles]) => ({ name, roles: [...roles] })),
    variants: [],
    sourceUrl: `${GCD}/issue/${id}/`,
    source: 'Grand Comics Database',
  };
}

function brief(r) {
  const sn = splitSeries(r.series_name);
  return {
    id: idOf(r.api_url),
    series: sn.name,
    year: sn.year,
    number: String(r.descriptor || '').replace(/\s*\[.*$/, ''),
    variant: /\[(.*)\]/.exec(r.descriptor || '')?.[1] || null,
    isVariant: !!r.variant_of,
    title: `${r.series_name} #${r.descriptor}`,
    coverDate: r.publication_date || null,
    image: null,
  };
}


/** Title search: series name (+ issue number, + series start year). */
export async function search({ series: name, number, year }) {
  const n = encodeURIComponent(name.trim());
  let path;
  if (number) path = year ? `/api/series/name/${n}/issue/${encodeURIComponent(number)}/year/${year}/` : `/api/series/name/${n}/issue/${encodeURIComponent(number)}/`;
  else path = year ? `/api/series/name/${n}/year/${year}/` : `/api/series/name/${n}/`;
  const r = await api(path);
  if (!number) {
    // Series only: show the series' first issues so the user can narrow down.
    return (r?.results || []).slice(0, 30).map(s => ({ id: null, seriesId: idOf(s.api_url), series: s.name, year: s.year_began, title: `${s.name} (${s.year_began})`, number: '', coverDate: `${s.year_began}${s.year_ended ? '–' + s.year_ended : ''}`, image: null, isSeries: true }));
  }
  let list = (r?.results || []).map(brief).filter(b => b.id);
  // Main covers first, newest series first.
  list.sort((a, b) => (a.isVariant - b.isVariant) || ((b.year || 0) - (a.year || 0)));
  list = list.slice(0, 40);
  return list; // covers load when an issue is opened (each one costs a GCD request)
}

/* ---------------- barcodes ----------------
 * A US comic barcode = 12-digit UPC (identifies the SERIES) + 5-digit add-on
 * (issue number, cover, printing). GCD stores every issue's barcode, so:
 *  1. If the relay has already learned which GCD series a UPC belongs to, it looks the
 *     issue number up in that series and confirms the exact barcode.
 *  2. Otherwise the app asks for the series title once; the match is confirmed against
 *     GCD's barcode and remembered for everyone.
 */

const digits = s => String(s || '').replace(/\D/g, '');

export function parseCode(code) {
  let d = digits(code);
  let base = d, addon = '';
  if (d.length === 18 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 17) { base = d.slice(0, 12); addon = d.slice(12); }
  else if (d.length === 13 && d.startsWith('0') && !/^97[89]/.test(d)) base = d.slice(1);
  else base = d;
  return {
    code: base + addon, base, addon: addon || null,
    issue: addon ? String(+addon.slice(0, 3)) : null,
    cover: addon ? addon[3] : null,
    printing: addon ? addon[4] : null,
    isbn: /^97[89]\d{10}$/.test(base),
  };
}

function sameCode(gcdBarcode, p) {
  for (const raw of String(gcdBarcode || '').split(/[;,]/)) {
    let g = digits(raw);
    if (g.length === 18 && g.startsWith('0')) g = g.slice(1);
    if (g.length === 13 && g.startsWith('0') && !/^97[89]/.test(g)) g = g.slice(1);
    if (!g) continue;
    if (p.addon ? g === p.base + p.addon : g.slice(0, 12) === p.base || g === p.base) return true;
  }
  return false;
}
const sameBase = (gcdBarcode, p) => String(gcdBarcode || '').split(/[;,]/).some(raw => {
  let g = digits(raw);
  if (g.length === 18 && g.startsWith('0')) g = g.slice(1);
  if (g.length === 13 && g.startsWith('0')) g = g.slice(1);
  return g.slice(0, 12) === p.base;
});

const lead = desc => String(desc || '').replace(/\s*\[.*$/, '').trim();

async function seriesIssues(id, kv) {
  const key = `series:${id}`;
  const hit = kv && await kv.get(key);
  if (hit) return hit;
  const s = await api(`/api/series/${id}/`);
  if (!s) return null;
  const out = {
    id, name: s.name, year: s.year_began || null,
    issues: (s.active_issues || []).map((u, i) => [idOf(u), String(s.issue_descriptors?.[i] || '')]),
  };
  if (kv) await kv.put(key, out, 24 * 3600);
  return out;
}

const detailCache = new Map();
async function rawIssue(id, kv) {
  if (detailCache.has(id)) return detailCache.get(id);
  const key = `raw:${id}`;
  let d = null;
  if (!d) {
    const full = await api(`/api/issue/${id}/`);
    if (!full) return null;
    d = { id, series_name: full.series_name, descriptor: full.descriptor, number: full.number, barcode: full.barcode, variant_name: full.variant_name, variant_of: full.variant_of, publication_date: full.publication_date, cover: full.cover, series: idOf(full.series) };
    // (kept in memory only: the free KV plan allows ~1,000 writes a day)
  }
  detailCache.set(id, d);
  return d;
}

function briefFromRaw(d, exact) {
  const sn = splitSeries(d.series_name);
  return { id: d.id, series: sn.name, year: sn.year, number: d.number || lead(d.descriptor), variant: d.variant_name || null, isVariant: !!d.variant_of, title: `${d.series_name} #${d.descriptor}`, coverDate: d.publication_date || null, image: d.cover || null, exact: !!exact };
}

/** Check candidate issue ids (main covers first) in small batches until the exact barcode turns up. */
async function confirm(ids, p, kv, cap = 12) {
  const seen = [];
  for (let i = 0; i < Math.min(ids.length, cap); i += 3) {
    const batch = await Promise.all(ids.slice(i, i + 3).map(id => rawIssue(id, kv).catch(() => null)));
    for (const d of batch) {
      if (!d) continue;
      if (sameCode(d.barcode, p)) return { exact: d, seen };
      seen.push(d);
    }
  }
  return { exact: null, seen };
}

/**
 * Look a scanned code up. Returns { issues, exact, needSeries, issueNumber }.
 * kv: { get(key), put(key, value, ttlSeconds) } (may be null)
 */
export async function byCode(code, kv) {
  const p = parseCode(code);
  const known = kv && await kv.get(`upc:${p.base}`);
  if (!known) return { issues: [], exact: false, needSeries: true, issueNumber: p.issue, base: p.base, addon: p.addon };
  const s = await seriesIssues(known.seriesId, kv);
  if (!s) return { issues: [], exact: false, needSeries: true, issueNumber: p.issue, base: p.base, addon: p.addon };
  let ids = s.issues.filter(([, desc]) => !p.issue || lead(desc) === p.issue).map(([id]) => id);
  if (!ids.length) return { issues: [], exact: false, needSeries: true, issueNumber: p.issue, base: p.base, addon: p.addon, series: s.name };
  // the cover digit tells which cover: "1" is normally the main cover (listed first)
  if (p.cover && p.cover !== '1') ids = ids.slice(1).concat(ids.slice(0, 1));
  const { exact, seen } = await confirm(ids, p, kv);
  if (exact) return { issues: [briefFromRaw(exact, true)], exact: true, needSeries: false };
  return { issues: seen.map(d => briefFromRaw(d, false)).slice(0, 25), exact: false, needSeries: false, issueNumber: p.issue, series: s.name };
}

/** Title search that also checks a scanned barcode and remembers the series for next time. */
export async function searchWithCode({ series: name, number, year, code }, kv) {
  const p = parseCode(code);
  const n = encodeURIComponent(name.trim());
  const num = number || p.issue;
  const path = num
    ? (year ? `/api/series/name/${n}/issue/${encodeURIComponent(num)}/year/${year}/` : `/api/series/name/${n}/issue/${encodeURIComponent(num)}/`)
    : (year ? `/api/series/name/${n}/year/${year}/` : `/api/series/name/${n}/`);
  const r = await api(path);
  const rows = (r?.results || []).filter(x => x.api_url && /\/issue\//.test(x.api_url));
  rows.sort((a, b) => (!!a.variant_of - !!b.variant_of));
  const ids = rows.map(x => idOf(x.api_url)).filter(Boolean);
  const { exact, seen } = await confirm(ids, p, kv, 15);
  if (exact) {
    if (kv) await kv.put(`upc:${p.base}`, { seriesId: exact.series, series: exact.series_name }, 0);
    return { issues: [briefFromRaw(exact, true)], exact: true };
  }
  // No exact barcode match: still learn the series if a candidate shares the base UPC.
  const sb = seen.find(d => sameBase(d.barcode, p));
  if (sb && kv) await kv.put(`upc:${p.base}`, { seriesId: sb.series, series: sb.series_name }, 0);
  const list = seen.map(d => briefFromRaw(d, false));
  return { issues: list.length ? list : rows.slice(0, 30).map(brief), exact: false };
}
