// Store adapters: find copies of one comic for sale and their current prices.
// Each adapter does ONE search request per lookup (plus at most two product
// requests for Shopify stores). Results are cached by the relay.
//
// The HTML is parsed with a DOM-like API (linkedom in the relay, DOMParser in
// tests), so only querySelector/querySelectorAll/textContent/getAttribute are used.

const UA = 'Mozilla/5.0 (compatible; ComicScanRelay/1.0; +https://github.com/chadant1/comic-scan)';

/* ------------------------------------------------------------ helpers */

export const norm = s => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9#. ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const text = el => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const money = s => {
  const m = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(String(s || ''));
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
};
const abs = (base, href) => {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch (e) { return null; }
};

const BETWEEN_OK = /^(\d{4}|vol\.?|volume|v\d+|\d{1,2}|series|\d+(st|nd|rd|th)|the|ongoing|comic|comics)$/;

/**
 * Does a store's product title describe this comic?
 * The title must START with the series name; between the name and "#<number>"
 * only a year, a volume or "series" wording may appear ("Amazing Spider-Man
 * (1963 1st Series) #300", "Batman Vol 3 #1"). Years/volumes must agree when known.
 * With number == null only the series prefix is checked (collected editions).
 */
export function matches(title, ctx) {
  const t = norm(title).replace(/^the /, '');
  const series = norm(ctx.series).replace(/^the /, '');
  if (!series || !t.startsWith(series)) return false;
  const rest = t.slice(series.length);
  if (rest && !/^[\s#.]/.test(rest)) return false; // "Batman" must not match "Batmanga"
  if (ctx.number == null || ctx.number === '') return true;
  const n = String(ctx.number).replace(/^0+(?=\d)/, '');
  const m = new RegExp(`#\\s*0*${esc(n.toLowerCase())}(?![\\d.a-z])`).exec(rest);
  if (!m) return false;
  const between = rest.slice(0, m.index).trim().split(/\s+/).filter(Boolean);
  if (!between.every(w => BETWEEN_OK.test(w))) return false;
  const years = between.filter(w => /^\d{4}$/.test(w)).map(Number);
  if (ctx.year && years.length && !years.some(y => Math.abs(y - ctx.year) <= 1)) return false;
  const vi = between.findIndex(w => /^vol/.test(w));
  if (ctx.volume && vi >= 0 && /^\d+$/.test(between[vi + 1] || '') && +between[vi + 1] !== +ctx.volume) return false;
  return true;
}

const SLAB = /\b(CGC|CBCS|PGX)\s*(SS|Signature Series|Qualified|Q)?\s*(10(?:\.0)?|\d(?:\.\d)?)\b/i;
const RAW = /\b(NM\/M|NM\+|NM-|NM|VF\/NM|VF\+|VF-|VF|FN\/VF|FN\+|FN-|FN|VG\/FN|VG\+|VG-|VG|GD\/VG|GD\+|GD-|GD|FR\/GD|FR|PR)\s*(\d{1,2}\.\d)?\b/;
const WORD_GRADES = [
  ['near mint/mint', 'NM/M 9.8'], ['near mint +', 'NM+ 9.6'], ['near mint+', 'NM+ 9.6'], ['near mint -', 'NM- 9.2'], ['near mint-', 'NM- 9.2'], ['near mint', 'NM 9.4'],
  ['very fine/near mint', 'VF/NM 9.0'], ['very fine +', 'VF+ 8.5'], ['very fine+', 'VF+ 8.5'], ['very fine -', 'VF- 7.5'], ['very fine-', 'VF- 7.5'], ['very fine', 'VF 8.0'],
  ['fine/very fine', 'FN/VF 7.0'], ['fine +', 'FN+ 6.5'], ['fine+', 'FN+ 6.5'], ['fine -', 'FN- 5.5'], ['fine-', 'FN- 5.5'],
  ['very good/fine', 'VG/FN 5.0'], ['very good +', 'VG+ 4.5'], ['very good+', 'VG+ 4.5'], ['very good -', 'VG- 3.5'], ['very good-', 'VG- 3.5'], ['very good', 'VG 4.0'],
  ['good/very good', 'GD/VG 3.0'], ['good +', 'GD+ 2.5'], ['good+', 'GD+ 2.5'], ['good -', 'GD- 1.8'], ['good-', 'GD- 1.8'],
  ['fair', 'FR 1.0'], ['poor', 'PR 0.5'],
];

/** "CGC 9.8", "CGC SS 9.6", "VF 8.0", "NM 9.4" … or null. */
export function grade(s) {
  const str = String(s || '');
  const m = SLAB.exec(str);
  if (m) return { label: `${m[1].toUpperCase()}${m[2] ? ' ' + (/^s/i.test(m[2]) ? 'SS' : 'Q') : ''} ${m[3]}`, slab: true, value: parseFloat(m[3]) };
  const r = RAW.exec(str);
  if (r) return { label: r[2] ? `${r[1]} ${r[2]}` : r[1], slab: false, value: r[2] ? parseFloat(r[2]) : null };
  const low = str.toLowerCase();
  for (const [w, g] of WORD_GRADES) {
    if (low.includes(w)) return { label: g, slab: false, value: parseFloat(g.split(' ').pop()) };
  }
  if (/\bfine\b/.test(low)) return { label: 'FN 6.0', slab: false, value: 6 };
  if (/\bgood\b/.test(low)) return { label: 'GD 2.0', slab: false, value: 2 };
  return null;
}

async function get(url, { json = false, timeout = 9000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

const query = ctx => `${String(ctx.series || '').replace(/^the\s+/i, '')} ${ctx.number ?? ''}`.trim();

/* ------------------------------------------------------------ MyComicShop */

export const mycomicshop = {
  id: 'mycomicshop',
  name: 'MyComicShop',
  searchUrl: ctx => `https://www.mycomicshop.com/search?q=${encodeURIComponent(query(ctx))}`,
  parse(doc, ctx) {
    const items = [];
    for (const li of doc.querySelectorAll('li.issue')) {
      const title = text(li.querySelector('div.title'));
      if (!title || !matches(title, ctx)) continue;
      const tab = [...li.querySelectorAll('a')].map(a => a.getAttribute('href') || '').find(h => /#tab-addtocart-\d+/.test(h));
      const ivid = tab ? /(\d+)$/.exec(tab)[1] : null;
      const img = li.querySelector('a.fancyboxthis')?.getAttribute('href') || null;
      const link = ivid ? `https://www.mycomicshop.com/search?ivid=${ivid}` : abs('https://www.mycomicshop.com/', li.querySelector('div.title a')?.getAttribute('href'));
      for (const td of li.querySelectorAll('table.issuestock td')) {
        const t = text(td);
        const cls = td.getAttribute('class') || '';
        const auction = /auc/.test(cls) || /Auction Item/i.test(t);
        const g = grade(t.replace(/^.*?(Add to cart|Auction Item:)/i, ''));
        let price = null, kind = 'buy', note = '';
        if (auction) {
          kind = 'bid';
          const bid = /Current bid:\s*(\$[\d,.]+)/i.exec(t);
          price = bid ? money(bid[1]) : null;
          const opens = /Auction opens ([A-Za-z]+ \d+)/i.exec(t);
          const left = /Time left:\s*([^P]+?)(?:Paper|Label|$)/i.exec(t);
          note = bid ? `Auction${left ? ' · ' + left[1].trim() + ' left' : ''}` : (opens ? `Auction opens ${opens[1]}` : 'Auction');
        } else {
          price = money(t);
          if (/or Best Offer/i.test(t)) { kind = 'offer'; note = 'or Best Offer'; }
          if (/buyer's premium/i.test(t)) note = (note ? note + ' · ' : '') + '3% buyer’s premium';
        }
        if (price == null && kind !== 'bid') continue;
        if (/Signature Series/i.test(t) && g && g.slab && !/SS/.test(g.label)) g.label = g.label.replace(/^(\w+)/, '$1 SS');
        items.push({ title, grade: g?.label || null, slab: !!g?.slab, gradeValue: g?.value ?? null, price, kind, note, url: link, img });
      }
    }
    return items;
  },
};

/* ------------------------------------------------------------ Midtown Comics */

export const midtown = {
  id: 'midtown',
  name: 'Midtown Comics',
  searchUrl: ctx => `https://www.midtowncomics.com/search?q=${encodeURIComponent(query(ctx))}`,
  parse(doc, ctx) {
    const items = [];
    for (const card of doc.querySelectorAll('div.product-card')) {
      const title = text(card.querySelector('.product-title h3')) || text(card.querySelector('.product-title'));
      if (!title || !matches(title, ctx)) continue;
      const url = abs('https://www.midtowncomics.com/', card.querySelector('.product-title a')?.getAttribute('href'));
      const img = abs('https://www.midtowncomics.com/', card.querySelector('.product-img img')?.getAttribute('src'));
      if (/out of stock|sold out/i.test(text(card))) continue;
      const opts = [...card.querySelectorAll('select option')].map(o => text(o)).filter(t => /\$\d/.test(t));
      const was = money(text(card.querySelector('.price1')));
      if (opts.length) {
        for (const o of opts) {
          const cond = o.replace(/\s*-?\s*\$[\d,.]+.*$/, '').trim(); // "Near Mint - $4.88" -> "Near Mint"
          const g = grade(title) || grade(cond);
          items.push({ title, grade: g?.label || null, slab: !!g?.slab, gradeValue: g?.value ?? null, price: money(o), kind: 'buy', note: g?.slab ? '' : cond, url, img });
        }
      } else {
        const price = money(text(card.querySelector('.price2'))) ?? money(text(card));
        if (price == null) continue;
        const g = grade(title);
        items.push({ title, grade: g?.label || null, slab: !!g?.slab, gradeValue: g?.value ?? null, price, kind: 'buy', note: was && was > price ? `was $${was.toFixed(2)}` : '', url, img });
      }
    }
    return items;
  },
};

/* ------------------------------------------------------------ InStockTrades (collected editions) */

export const instocktrades = {
  id: 'instocktrades',
  name: 'InStockTrades',
  tradesOnly: true,
  searchUrl: ctx => `https://www.instocktrades.com/search?term=${encodeURIComponent(String(ctx.series || '').replace(/^the\s+/i, '') + (ctx.volume ? ' vol ' + ctx.volume : ''))}`,
  parse(doc, ctx) {
    const items = [];
    for (const it of doc.querySelectorAll('div.item')) {
      const a = [...it.querySelectorAll('a')].find(x => text(x));
      const title = text(a);
      if (!title || !matches(title, { ...ctx, number: null, year: null })) continue;
      if (ctx.volume && !new RegExp(`vol(?:ume)?\\.?\\s*0*${esc(String(ctx.volume))}\\b`, 'i').test(title)) continue;
      const prices = (text(it.querySelector('.pricing')).match(/\$[\d,]+\.\d\d/g) || []).map(money);
      if (!prices.length) continue;
      const price = prices[prices.length - 1];
      const list = prices.length > 1 ? prices[0] : null;
      items.push({ title, grade: 'New', slab: false, gradeValue: null, price, kind: 'buy', note: list && list > price ? `list $${list.toFixed(2)}` : '', url: abs('https://www.instocktrades.com/', a.getAttribute('href')), img: abs('https://www.instocktrades.com/', it.querySelector('img')?.getAttribute('src')) });
    }
    return items.slice(0, 8);
  },
};

/* ------------------------------------------------------------ Shopify stores (Comic Source / Newkadia, Infinity Flux) */

function shopify(id, name, origin) {
  return {
    id, name, shopify: true,
    searchUrl: ctx => `${origin}/search?q=${encodeURIComponent(query(ctx))}&type=product`,
    async run(ctx) {
      const q = encodeURIComponent(query(ctx));
      const j = await get(`${origin}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`, { json: true });
      const products = (j?.resources?.results?.products || []).filter(p => matches(p.title, ctx)).slice(0, 2);
      const items = [];
      for (const p of products) {
        let detail = null;
        try { detail = await get(`${origin}/products/${p.handle}.js`, { json: true }); } catch (e) { /* use summary */ }
        const img = (p.image || p.featured_image?.url || detail?.featured_image || null);
        const imgUrl = img ? (img.startsWith('//') ? 'https:' + img : img) : null;
        const variants = detail?.variants || [];
        if (!variants.length) {
          if (p.available && parseFloat(p.price) > 0) {
            const g = grade(p.title);
            items.push({ title: p.title, grade: g?.label || null, slab: !!g?.slab, gradeValue: g?.value ?? null, price: parseFloat(p.price), kind: 'buy', note: '', url: `${origin}${p.url || '/products/' + p.handle}`.split('?')[0], img: imgUrl });
          }
          continue;
        }
        for (const v of variants) {
          if (!v.available) continue;
          const price = (typeof v.price === 'number' ? v.price / 100 : parseFloat(v.price));
          if (!(price > 0)) continue;
          const vt = v.title && v.title !== 'Default Title' ? v.title : '';
          const g = grade(vt) || grade(p.title);
          const edition = vt.split('/').length > 1 ? vt.split('/')[0].trim() : '';
          items.push({ title: p.title + (vt ? ` – ${vt}` : ''), grade: g?.label || null, slab: !!g?.slab, gradeValue: g?.value ?? null, price, kind: 'buy', note: edition, url: `${origin}/products/${p.handle}?variant=${v.id}`, img: imgUrl });
        }
      }
      return items;
    },
  };
}

export const comicsource = shopify('comicsource', 'Comic Source (Newkadia)', 'https://comicsource.com');
export const infinityflux = shopify('infinityflux', 'Infinity Flux', 'https://infinityflux.net');

export const STORES = [mycomicshop, midtown, comicsource, infinityflux, instocktrades];

/** Run every store; never throws. parseHTML(html) must return a Document-like object. */
export async function searchAll(ctx, parseHTML) {
  const stores = STORES.filter(s => !s.tradesOnly || ctx.trade);
  const results = await Promise.all(stores.map(async s => {
    const base = { id: s.id, name: s.name, searchUrl: s.searchUrl(ctx) };
    try {
      let items;
      if (s.run) items = await s.run(ctx);
      else items = s.parse(parseHTML(await get(s.searchUrl(ctx))), ctx);
      items.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
      return { ...base, ok: true, items: items.slice(0, 25) };
    } catch (e) {
      return { ...base, ok: false, error: String(e.message || e), items: [] };
    }
  }));
  return results;
}
