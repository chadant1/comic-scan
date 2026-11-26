// Grand Comics Database (https://www.comics.org) – open comic data (CC BY-SA 4.0).
//  • Issue details and title search come from GCD's public data API (no login).
//  • Barcode → issue comes from a small index this repo builds from GCD's
//    monthly data download and publishes on its `data` branch.

const GCD = 'https://www.comics.org';
const INDEX = 'https://raw.githubusercontent.com/chadant1/comic-scan/data';
const UA = 'ComicScanRelay/1.0 (+https://github.com/chadant1/comic-scan)';

export class GcdError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path) {
  const url = path.startsWith('http') ? path : GCD + path;
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'format=json', {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) return null;
  if (res.status === 429) throw new GcdError('The comic database is busy. Try again in a minute.', 429);
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
  const s = await series(d.series);
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

async function withCovers(list, n = 8) {
  await Promise.all(list.slice(0, n).map(async b => {
    try { const d = await api(`/api/issue/${b.id}/`); b.image = d?.cover || null; } catch (e) { /* no cover */ }
  }));
  return list;
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
  return withCovers(list);
}

/* ---------------- barcode index (built from GCD's data download) ---------------- */

const shardKey = base => base.slice(0, 7);

/**
 * Look a scanned code up. `code` is 12/13 digits, or 17 with the 5-digit add-on.
 * Returns briefs, best first. An exact match (incl. add-on) is returned alone.
 */
export async function byCode(code) {
  const digits = String(code).replace(/\D/g, '');
  let base = digits, addon = '';
  if (digits.length === 17 || digits.length === 18) { base = digits.slice(0, -5); addon = digits.slice(-5); }
  if (base.length === 13 && base.startsWith('0') && !/^97[89]/.test(base)) base = base.slice(1);
  const res = await fetch(`${INDEX}/b/${shardKey(base)}.json`, { signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new GcdError('The barcode list is unavailable right now.', 502);
  const shard = await res.json();
  const rows = shard[base] || [];
  if (!rows.length) return [];
  // rows: [issueId, addon, "Series (year)", "number", "variant name"]
  const toBrief = ([id, ad, label, num, variant]) => {
    const sn = /^(.*?)\s*\((\d{4})\)$/.exec(label) || [null, label, null];
    return { id, series: sn[1], year: sn[2] ? +sn[2] : null, number: num, variant: variant || null, title: `${label} #${num}${variant ? ` [${variant}]` : ''}`, coverDate: null, image: null, addon: ad };
  };
  if (addon) {
    const exact = rows.filter(r => r[1] === addon);
    if (exact.length) return withCovers(exact.map(toBrief), 6);
    const sameIssue = rows.filter(r => r[1] && r[1].slice(0, 3) === addon.slice(0, 3));
    if (sameIssue.length) return withCovers(sameIssue.map(toBrief), 8);
  }
  if (rows.length === 1 && !rows[0][1]) return withCovers(rows.map(toBrief), 1);
  return withCovers(rows.slice(0, 25).map(toBrief), 8);
}
