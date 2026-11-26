import * as store from './store.js';
import * as api from './api.js';
import * as barcode from './barcode.js';
import { readCover } from './cover.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => (v == null ? '–' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const when = d => {
  if (!d) return '';
  const t = new Date(String(d).length === 10 ? d + 'T12:00:00' : d);
  return isNaN(t) ? '' : t.toLocaleDateString('en-US', { month: 'short', year: 'numeric', ...(String(d).length === 10 && !d.endsWith('-01') ? { day: 'numeric' } : {}) });
};

/* ================= theme ================= */
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => { const t = document.documentElement.dataset.theme; return t === 'dark' || (t === 'system' && darkMQ.matches); };
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('cs.theme', t); } catch (e) {}
  $('#metaTheme').setAttribute('content', isDark() ? '#0f1115' : '#f5f6f8');
  document.querySelectorAll('#themeSeg button').forEach(b => { b.classList.toggle('on', b.dataset.v === t); b.setAttribute('aria-checked', b.dataset.v === t); });
}
darkMQ.addEventListener?.('change', () => applyTheme(document.documentElement.dataset.theme));
$('#themeBtn').addEventListener('click', () => applyTheme(isDark() ? 'light' : 'dark'));
document.querySelectorAll('#themeSeg button').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.v)));

/* ================= toast ================= */
let toastT;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ================= routing ================= */
let currentView = null;
let chooseState = null;

function show(view, title) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + view));
  const tab = { scan: 'scan', choose: 'scan', comic: null, search: 'search', history: 'history', settings: 'settings' }[view];
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === tab));
  $('#title').textContent = title || $('#view-' + view).dataset.title || 'ComicScan';
  $('#backBtn').classList.toggle('hidden', !['comic', 'choose'].includes(view));
  if (view !== 'scan' && currentView === 'scan') camera.pause();
  if (view === 'scan' && camera.wanted) camera.start();
  currentView = view;
  window.scrollTo(0, 0);
}
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [view, arg] = h.split('/');
  switch (view) {
    case 'comic': return arg ? openComic(+arg) : show('scan');
    case 'choose': return chooseState ? renderChoose() : go('#scan');
    case 'search': return show('search');
    case 'history': renderHistory(); return show('history');
    case 'settings': renderSettings(); return show('settings');
    default: return show('scan');
  }
}
window.addEventListener('hashchange', route);
document.querySelectorAll('#tabbar button').forEach(b => b.addEventListener('click', () => go('#' + b.dataset.view)));
$('#backBtn').addEventListener('click', () => (history.length > 1 ? history.back() : go('#scan')));
function go(h) { if (location.hash === h) route(); else location.hash = h; }

/* ================= camera + live barcode scanning ================= */
const video = $('#video');
const camera = {
  stream: null, track: null, wanted: false, torch: false, timer: null,
  async start() {
    this.wanted = true;
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) return camMsg('This browser can’t open the camera. Use the photo button or the Search tab.', false);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      this.stream = null;
      return camMsg(e.name === 'NotAllowedError'
        ? 'Camera access was blocked. On iPhone: Settings → Safari → Camera → Allow (or allow it for ComicScan), then tap Start camera.'
        : 'Couldn’t open the camera (' + esc(e.message || e.name) + ').', true);
    }
    video.srcObject = this.stream;
    try { await video.play(); } catch (e) {}
    this.track = this.stream.getVideoTracks()[0];
    const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
    $('#torchBtn').disabled = !caps.torch;
    if (caps.focusMode?.includes('continuous')) this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    $('#camMsg').classList.add('hidden');
    $('#coverBtn').disabled = false;
    barcode.init().catch(e => toast(e.message));
    this.loop();
  },
  pause() {
    clearTimeout(this.timer);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.track = null; this.torch = false;
    $('#torchBtn').classList.remove('on');
    video.srcObject = null;
    $('#coverBtn').disabled = true;
  },
  async toggleTorch() {
    if (!this.track) return;
    this.torch = !this.torch;
    try { await this.track.applyConstraints({ advanced: [{ torch: this.torch }] }); } catch (e) { this.torch = false; toast('Flashlight isn’t available.'); }
    $('#torchBtn').classList.toggle('on', this.torch);
  },
  loop() {
    clearTimeout(this.timer);
    const tick = async () => {
      if (!this.stream) return;
      if (!busy && video.videoWidth) {
        try { await scanFrame(); } catch (e) { /* keep trying */ }
      }
      this.timer = setTimeout(tick, 180);
    };
    tick();
  },
};
function camMsg(html, showBtn) {
  $('#camMsg').classList.remove('hidden');
  $('#camMsgText').innerHTML = html;
  $('#startCamBtn').classList.toggle('hidden', !showBtn);
}
$('#startCamBtn').addEventListener('click', () => camera.start());
$('#torchBtn').addEventListener('click', () => camera.toggleTorch());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { const w = camera.wanted; camera.pause(); camera.wanted = w; }
  else if (currentView === 'scan' && camera.wanted) camera.start();
});

/** The camera area inside an on-screen element, at camera resolution. */
function grab(el, maxW = 1400) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const vr = video.getBoundingClientRect(), gr = el.getBoundingClientRect();
  const s = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vr.width - vw * s) / 2, oy = (vr.height - vh * s) / 2;
  let sx = Math.max(0, (gr.left - vr.left - ox) / s), sy = Math.max(0, (gr.top - vr.top - oy) / s);
  let sw = Math.min(vw - sx, gr.width / s), sh = Math.min(vh - sy, gr.height / s);
  // a little margin around the guide so the add-on isn't cut off
  const mx = sw * 0.08, my = sh * 0.15;
  sx = Math.max(0, sx - mx); sy = Math.max(0, sy - my); sw = Math.min(vw - sx, sw + 2 * mx); sh = Math.min(vh - sy, sh + 2 * my);
  const k = Math.min(1, maxW / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

let busy = false;
let baseOnly = { base: null, count: 0 };
let lastHit = { code: null, t: 0 };
async function scanFrame() {
  const c = grab($('#guide'));
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  const r = await barcode.read(img);
  if (!r) return;
  if (pending && r.base === pending.base) return;               // already asking about this one
  if (lastHit.code === r.code && Date.now() - lastHit.t < 6000) return;
  lastHit = { code: r.code, t: Date.now() };
  if (r.addon || r.isbn) { baseOnly = { base: null, count: 0 }; return found(r); }
  // Got the UPC but not its add-on yet: keep trying for a moment before asking.
  if (baseOnly.base === r.base) baseOnly.count++; else baseOnly = { base: r.base, count: 1 };
  setStatus('Barcode found – hold still to read the small digits…');
  if (baseOnly.count >= 10) { baseOnly = { base: null, count: 0 }; askAddon(r.base); }
}

function setStatus(text) {
  $('#scanStatus').classList.toggle('hidden', !text);
  if (text) $('#scanStatusText').textContent = text;
}

async function found(r) {
  if (busy) return;
  busy = true;
  $('#guide').classList.add('found');
  if (navigator.vibrate) navigator.vibrate(30);
  $('#scanText').textContent = `Barcode: ${r.base}${r.addon ? '  add-on: ' + r.addon : ''}${r.isbn ? '  (ISBN)' : ''}`;
  $('#idPanel').classList.add('hidden');
  setStatus('Looking it up…');
  try { await lookupCode(r.code, r); }
  finally {
    busy = false;
    setStatus(null);
    setTimeout(() => $('#guide').classList.remove('found'), 800);
  }
}

let pending = null; // the barcode being identified

async function lookupCode(code, r = {}) {
  let res;
  try { res = await api.byCode(code); }
  catch (e) { handleApiError(e); return; }
  if (res.exact && res.issues?.length) return go('#comic/' + res.issues[0].id);
  if (res.needSeries) {
    pending = { code, base: res.base || r.base, issue: res.issueNumber || '' };
    return askSeries(res.series);
  }
  if (res.issues?.length) { chooseState = { list: res.issues, lead: `Found ${res.series || 'the series'} #${res.issueNumber || ''}, but not this exact cover. Tap yours:` }; return go('#choose'); }
  toast('That barcode isn’t in the comic database yet. Try the Search tab.');
}

function showIdPanel(title, html, { series = false, seriesValue = '', num = '' } = {}) {
  $('#idTitle').textContent = title;
  $('#idText').innerHTML = html;
  $('#idSeries').classList.toggle('hidden', !series);
  $('#idSeries').required = series;
  $('#idSeries').value = seriesValue;
  $('#idNum').value = num;
  $('#idPanel').classList.remove('hidden');
  setStatus(null);
  $('#idPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  (series ? $('#idSeries') : $('#idNum')).focus();
}

function askAddon(base) {
  pending = { code: null, base, issue: '', needAddon: true };
  showIdPanel('Almost there', `I read the barcode <b>${esc(base)}</b> but not the 5 small digits beside it. Type the issue number (or those 5 digits):`);
}

function askSeries(knownSeries) {
  showIdPanel('First scan of this series',
    `Nobody has scanned this series yet. Type its title as printed on the cover. After this, everyone's scans of this series are identified automatically.`,
    { series: true, seriesValue: knownSeries || '', num: pending.issue || '' });
}

$('#idForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!pending) return;
  busy = true;
  setStatus('Looking it up…');
  $('#idPanel').classList.add('hidden');
  try {
    if (pending.needAddon) {
      const code = barcode.withAddon(pending.base, $('#idNum').value);
      if (!code) { toast('Type the issue number.'); $('#idPanel').classList.remove('hidden'); return; }
      pending = null;
      await lookupCode(code, {});
      return;
    }
    const series = $('#idSeries').value.trim();
    if (!series) { $('#idPanel').classList.remove('hidden'); return; }
    setStatus('Checking the comic database (can take a few seconds)…');
    const r = await api.identify({ code: pending.code, series, number: $('#idNum').value.trim() || pending.issue });
    if (r.exact && r.issues.length) { pending = null; return go('#comic/' + r.issues[0].id); }
    if (r.issues?.length) { chooseState = { list: r.issues, lead: 'I couldn’t confirm the exact barcode. Tap your comic:' }; return go('#choose'); }
    toast('No match. Check the title spelling (e.g. “Amazing Spider-Man”).');
    $('#idPanel').classList.remove('hidden');
  } catch (err) { handleApiError(err); $('#idPanel').classList.remove('hidden'); }
  finally { busy = false; setStatus(null); }
});

/* ---- cover reading (no barcode) and photos ---- */
async function coverSearch(canvas) {
  busy = true;
  setStatus('Reading the cover…');
  try {
    const g = await readCover(canvas);
    $('#scanText').textContent = `Cover text: ${g.raw.replace(/\s+/g, ' ').slice(0, 400)}`;
    if (!g.series) { toast('Couldn’t read the title. Type it in the Search tab.'); go('#search'); return; }
    $('#searchSeries').value = g.series;
    $('#searchNum').value = g.number;
    go('#search');
    runSearch();
  } catch (e) { toast(e.message); }
  finally { canvas.width = canvas.height = 0; busy = false; setStatus(null); }
}
$('#coverBtn').addEventListener('click', () => {
  if (!video.videoWidth || busy) return;
  coverSearch(grab($('#cameraWrap'), 1600));
});
$('#photoInput').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f || busy) return;
  let bmp;
  try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch (err) { return toast('Couldn’t open that picture.'); }
  const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  setStatus('Looking for a barcode…');
  let r = null;
  try { r = await barcode.read(c.getContext('2d').getImageData(0, 0, c.width, c.height)); } catch (err) { /* fall through */ }
  setStatus(null);
  if (r && (r.addon || r.isbn)) { c.width = 0; return found(r); }
  if (r) { c.width = 0; return askAddon(r.base); }
  coverSearch(c);
});

function handleApiError(e) {
  if (e.setup) { showSetupNotice(); toast(e.message); return; }
  toast(e.message || 'Something went wrong.');
}

/* ================= choose / search ================= */
function tile(i) {
  const t = i.title || `${i.series}${i.year ? ` (${i.year})` : ''} #${i.number}`;
  if (i.isSeries) return `<button class="tile" data-series="${esc(i.series)}" data-year="${esc(i.year || '')}">
    <img loading="lazy" src="icons/no-cover.svg" alt=""><b>${esc(t)}</b><span>Series · ${esc(i.coverDate || '')} · tap, then add the issue #</span></button>`;
  return `<button class="tile" data-id="${esc(i.id)}">
    <img loading="lazy" src="${esc(i.image || 'icons/no-cover.svg')}" alt="" onerror="this.src='icons/no-cover.svg'">
    <b>${esc(t)}</b><span>${esc(when(i.coverDate))}</span></button>`;
}
function bindTiles(root) {
  root.querySelectorAll('.tile').forEach(t => t.addEventListener('click', () => {
    if (t.dataset.id) return go('#comic/' + t.dataset.id);
    $('#searchSeries').value = t.dataset.series; $('#searchYear').value = t.dataset.year;
    go('#search'); $('#searchNum').focus(); toast('Now type the issue number and tap Search.');
  }));
}
function renderChoose() {
  $('#chooseLead').textContent = chooseState.lead;
  $('#chooseGrid').innerHTML = chooseState.list.map(tile).join('');
  bindTiles($('#chooseGrid'));
  show('choose');
}
async function runSearch() {
  const series = $('#searchSeries').value.trim();
  if (!series) return;
  const number = $('#searchNum').value.trim().replace(/^#/, '');
  const year = +$('#searchYear').value || null;
  $('#searchInfo').innerHTML = '<span class="loading"><span class="spinner dark"></span>Searching…</span>';
  $('#searchGrid').innerHTML = '';
  try {
    const list = await api.search({ series, number, year });
    $('#searchInfo').textContent = list.length
      ? (list[0].isSeries ? `${list.length} series found. Tap one, then add the issue number.` : `${list.length} match${list.length === 1 ? '' : 'es'} (main covers first).`)
      : 'Nothing found. Check the spelling, or leave the issue # empty to find the series.';
    $('#searchGrid').innerHTML = list.map(tile).join('');
    bindTiles($('#searchGrid'));
  } catch (e) {
    $('#searchInfo').textContent = e.message;
    if (e.setup) showSetupNotice();
  }
}
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(); });

/* ================= comic page ================= */
let comicToken = 0;
async function openComic(id) {
  const token = ++comicToken;
  const v = $('#view-comic');
  v.innerHTML = '<div class="loading"><span class="spinner dark"></span>Loading comic…</div>';
  show('comic', 'Comic');
  let c;
  try { c = await api.issue(id); }
  catch (e) {
    if (token !== comicToken) return;
    v.innerHTML = `<div class="notice">${esc(e.message)}</div><button class="btn" id="retryC">Try again</button>`;
    $('#retryC').onclick = () => openComic(id);
    return;
  }
  if (token !== comicToken) return;
  const name = `${c.series}${c.year ? ` (${c.year})` : ''} #${c.number}`;
  const variantLine = c.variant ? `<div class="sub">${esc(c.variant)}${c.isVariant ? ' (variant)' : ''}</div>` : '';
  $('#title').textContent = `${c.series} #${c.number}`;
  const trade = /trade|hardcover|graphic novel|omnibus|tpb|hc/i.test(c.seriesType || '') || !!c.isbn;
  const q = encodeURIComponent(`${c.series} ${trade ? '' : '#' + c.number}`.trim());
  const qYear = encodeURIComponent(`${c.series} ${c.number} ${c.year || ''}`.trim());
  const credits = groupCredits(c.credits);

  v.innerHTML = `
    <div class="comic-head">
      <img src="${esc(c.image || 'icons/no-cover.svg')}" alt="Cover of ${esc(name)}" onerror="this.src='icons/no-cover.svg'">
      <div>
        <h2>${esc(name)}</h2>
        ${variantLine}${c.title ? `<div class="sub">“${esc(c.title)}”</div>` : ''}
        <div class="sub">${esc([c.publisher, (c.publicationDate || when(c.coverDate)) && 'Cover date ' + (c.publicationDate || when(c.coverDate))].filter(Boolean).join(' · '))}</div>
        <div class="chips">
          ${c.price ? `<span class="chip">Cover price $${esc(c.price)}</span>` : ''}
          ${c.seriesType ? `<span class="chip">${esc(c.seriesType)}</span>` : ''}
          ${c.pages ? `<span class="chip">${esc(c.pages)} pages</span>` : ''}
          ${c.rating && c.rating !== 'Unknown' ? `<span class="chip">${esc(c.rating)}</span>` : ''}
          ${c.brand ? `<span class="chip">${esc(c.brand.replace(/\s*\[.*\]$/, ''))}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="panel" id="pricePanel">
      <h3>For sale right now <small>cheapest first</small></h3>
      <div class="loading"><span class="spinner dark"></span>Checking Midtown, Comic Source, Infinity Flux${trade ? ', InStockTrades' : ''}…</div>
    </div>
    <div class="panel">
      <h3>Check other sites</h3>
      <div class="links">
        <a class="btn" target="_blank" rel="noopener" href="https://www.mycomicshop.com/search?q=${encodeURIComponent(`${c.series} ${c.number}`)}">MyComicShop</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.amazon.com/s?k=${qYear}&i=stripbooks">Amazon</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${qYear}&LH_Sold=1&LH_Complete=1">eBay sold</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.pricecharting.com/search-products?q=${qYear}&type=prices">PriceCharting</a>
        <a class="btn" target="_blank" rel="noopener" href="https://gocollect.com/search?q=${q}">GoCollect</a>
      </div>
    </div>
    <div class="panel details-text">
      <h3>About this issue</h3>
      ${c.desc ? `<p>${esc(c.desc)}</p>` : ''}
      ${c.stories.length ? `<p><b>Stories:</b> ${esc(c.stories.join(' · '))}</p>` : ''}
      ${credits.length ? `<dl class="credit-grid">${credits.map(([role, names]) => `<dt>${esc(role)}</dt><dd>${esc(names.join(', '))}</dd>`).join('')}</dl>` : ''}
      ${c.characters.length ? `<p><b>Characters:</b> ${esc(c.characters.slice(0, 20).join(', '))}${c.characters.length > 20 ? ' …' : ''}</p>` : ''}
      ${c.teams.length ? `<p><b>Teams:</b> ${esc(c.teams.join(', '))}</p>` : ''}
      ${c.arcs.length ? `<p><b>Story arc:</b> ${esc(c.arcs.join(', '))}</p>` : ''}
      ${c.storeDate ? `<p><b>On sale:</b> ${esc(when(c.storeDate))}</p>` : ''}
      ${c.upc ? `<p><b>UPC:</b> ${esc(c.upc)}</p>` : ''}${c.isbn ? `<p><b>ISBN:</b> ${esc(c.isbn)}</p>` : ''}
      ${c.notes ? `<p><b>Notes:</b> ${esc(c.notes)}</p>` : ''}
      <p class="small muted">Comic data from the <a href="${esc(c.sourceUrl || 'https://www.comics.org')}" target="_blank" rel="noopener">Grand Comics Database</a> (CC BY-SA 4.0). Cover image © its publisher.</p>
    </div>
    <div class="actions"><button class="btn primary" id="scanAnother">Scan another comic</button></div>`;
  $('#scanAnother').onclick = () => go('#scan');
  addHistory(c, null);
  loadPrices(c, trade, token, false);
}

function groupCredits(credits) {
  const order = ['Writer', 'Artist', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'Cover', 'Editor'];
  const map = new Map();
  for (const cr of credits || []) for (const r of cr.roles.length ? cr.roles : ['Creator']) {
    if (!map.has(r)) map.set(r, []);
    if (!map.get(r).includes(cr.name)) map.get(r).push(cr.name);
  }
  return [...map.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99)).slice(0, 8);
}

async function loadPrices(c, trade, token, force) {
  const panel = $('#pricePanel');
  if (force) panel.querySelector('.loading')?.remove();
  let data;
  try {
    data = await api.prices({ series: c.series, number: trade ? null : c.number, year: c.year, volume: c.volume, trade }, { force });
  } catch (e) {
    if (token !== comicToken) return;
    panel.innerHTML = `<h3>For sale right now</h3><div class="notice">${esc(e.message)}</div><button class="btn" id="retryP">Try again</button>`;
    $('#retryP').onclick = () => loadPrices(c, trade, token, true);
    return;
  }
  if (token !== comicToken) return;
  const stores = data.stores || [];
  const all = stores.flatMap(s => s.items.map(i => ({ ...i, store: s.name })));
  const buyable = all.filter(i => i.price != null && i.kind !== 'bid');
  addHistory(c, buyable.length ? Math.min(...buyable.map(i => i.price)) : null);

  // Summary: cheapest raw copy + cheapest copy at each slab grade (highest grades first).
  const sums = [];
  const raw = buyable.filter(i => !i.slab).sort((a, b) => a.price - b.price)[0];
  if (raw) sums.push({ g: trade ? 'Lowest price' : 'Cheapest raw copy', i: raw });
  const bySlab = new Map();
  for (const i of buyable.filter(x => x.slab)) {
    const k = i.grade.replace(/^(\w+)( SS| Q)? /, '$1 ');
    if (!bySlab.has(k) || bySlab.get(k).price > i.price) bySlab.set(k, i);
  }
  [...bySlab.entries()].sort((a, b) => (b[1].gradeValue || 0) - (a[1].gradeValue || 0)).slice(0, 5).forEach(([g, i]) => sums.push({ g, i }));

  const offer = i => `<a class="offer" href="${esc(i.url)}" target="_blank" rel="noopener">
      <span class="gchip${i.slab ? ' slab' : ''}">${esc(i.grade || (trade ? 'New' : 'Copy'))}</span>
      <span class="mid"><span class="t">${esc(i.title)}</span>${i.note ? `<span class="n">${esc(i.note)}</span>` : ''}</span>
      <span class="pr">${i.price != null ? money(i.price) : '—'}<small>${i.kind === 'bid' ? 'current bid' : i.kind === 'offer' ? 'or offer' : 'buy now'}</small></span>
    </a>`;

  const storeHTML = s => {
    const head = `<div class="store-head"><b>${esc(s.name)}${s.items.length ? ` · ${s.items.length}` : ''}</b><a href="${esc(s.searchUrl)}" target="_blank" rel="noopener">Open site ›</a></div>`;
    if (s.blocked) return `<div class="store">${head}<div class="store-empty">This shop doesn’t allow automatic price checks. Tap “Open site” to see its copies.</div></div>`;
    if (!s.ok) return `<div class="store">${head}<div class="store-empty">Couldn’t check right now (${esc(s.error)}).</div></div>`;
    if (!s.items.length) return `<div class="store">${head}<div class="store-empty">None in stock right now.</div></div>`;
    const first = s.items.slice(0, 5).map(offer).join('');
    const rest = s.items.slice(5);
    return `<div class="store">${head}${first}${rest.length ? `<div class="rest hidden">${rest.map(offer).join('')}</div><button class="btn small ghost more-btn">Show ${rest.length} more</button>` : ''}</div>`;
  };

  panel.innerHTML = `
    <h3>For sale right now <small>cheapest first</small></h3>
    ${sums.length ? `<div class="summary">${sums.map(s => `<a class="sum" href="${esc(s.i.url)}" target="_blank" rel="noopener"><div class="g">${esc(s.g)}</div><div class="p">${money(s.i.price)}</div><div class="s">${esc(s.i.store)}${s.i.grade && !s.i.slab ? ' · ' + esc(s.i.grade) : ''}</div></a>`).join('')}</div>`
      : '<p class="small muted">No shop has this one in stock right now. Try the links below.</p>'}
    ${stores.map(storeHTML).join('')}
    <div class="row" style="margin-top:10px;justify-content:space-between">
      <span class="small muted">Checked ${esc(ago(data.fetchedAt))}. Prices can change; shipping not included.</span>
      <button class="btn small ghost" id="refreshP">Refresh</button>
    </div>`;
  panel.querySelectorAll('.more-btn').forEach(b => b.addEventListener('click', () => { b.previousElementSibling.classList.remove('hidden'); b.remove(); }));
  $('#refreshP').onclick = () => { panel.innerHTML = '<h3>For sale right now</h3><div class="loading"><span class="spinner dark"></span>Checking the shops again…</div>'; loadPrices(c, trade, token, true); };
}

function ago(t) {
  if (!t) return 'just now';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
}

/* ================= recent ================= */
function addHistory(c, low) {
  const list = store.get('history', []);
  const prev = list.find(h => h.id === c.id);
  const rest = list.filter(h => h.id !== c.id);
  rest.unshift({ id: c.id, name: `${c.series}${c.year ? ` (${c.year})` : ''} #${c.number}`, publisher: c.publisher, image: c.image, low: low ?? prev?.low ?? null, t: Date.now() });
  store.set('history', rest.slice(0, 100));
}
function renderHistory() {
  const list = store.get('history', []);
  const root = $('#historyList');
  if (!list.length) { root.innerHTML = '<p class="empty">Comics you look up will show up here.</p>'; return; }
  root.innerHTML = list.map(h => `<button class="item" data-id="${esc(h.id)}">
      <img loading="lazy" src="${esc(h.image || 'icons/no-cover.svg')}" alt="" onerror="this.src='icons/no-cover.svg'">
      <div><b>${esc(h.name)}</b><span>${esc(h.publisher || '')}</span></div>
      <div class="v">${h.low != null ? 'from ' + money(h.low) : ''}</div></button>`).join('');
  root.querySelectorAll('.item').forEach(b => b.addEventListener('click', () => go('#comic/' + b.dataset.id)));
}

/* ================= settings ================= */
function renderSettings() {
  $('#relayUrl').value = api.relayUrl();
  $('#relayStatus').textContent = '';
  applyTheme(document.documentElement.dataset.theme);
}
$('#saveRelay').addEventListener('click', () => { api.setRelay($('#relayUrl').value); toast('Saved.'); checkSetup(); });
$('#testRelay').addEventListener('click', async () => {
  api.setRelay($('#relayUrl').value);
  $('#relayStatus').textContent = 'Testing…';
  try {
    const h = await api.health();
    $('#relayStatus').textContent = h.ok ? 'Connected. Everything works.' : 'The relay answered, but something is off.';
  } catch (e) { $('#relayStatus').textContent = e.message; }
});
$('#clearCache').addEventListener('click', () => { const n = store.clearCache(); toast(`Cleared ${n} saved results.`); });
$('#clearHistory').addEventListener('click', () => { store.del('history'); renderHistory(); toast('Recent comics cleared.'); });

function showSetupNotice() {
  const n = $('#setupNotice');
  n.innerHTML = 'This copy of ComicScan isn’t connected to its relay yet, so lookups won’t work. If you run this app, see <b>One-time setup</b> in the README.';
  n.classList.remove('hidden');
}
function checkSetup() {
  if (!api.relayUrl()) showSetupNotice(); else $('#setupNotice').classList.add('hidden');
}

/* ================= start ================= */
applyTheme(document.documentElement.dataset.theme || 'system');
checkSetup();
route();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
