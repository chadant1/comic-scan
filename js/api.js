// Talks to the owner's free relay (Cloudflare Worker) – see relay/.
import { fetchJSON } from './net.js';
import * as store from './store.js';
import { RELAY_URL } from './config.js';

export const relayUrl = () => (store.get('relay', '') || RELAY_URL || '').replace(/\/+$/, '');
export const setRelay = u => store.set('relay', (u || '').trim());

async function call(path, params, { ttl = 0, key = null } = {}) {
  const base = relayUrl();
  if (!base) {
    const e = new Error('This copy of ComicScan isn’t connected to its price relay yet.');
    e.setup = true;
    throw e;
  }
  const ck = key ? 'api.' + key : null;
  if (ck && ttl) {
    const c = store.cached(ck, ttl);
    if (c) return c;
  }
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  try {
    const { data } = await fetchJSON(`${base}${path}${qs ? '?' + qs : ''}`, { timeout: 30000 });
    if (ck && ttl) store.putCache(ck, data);
    return data;
  } catch (e) {
    const msg = e.body && e.body.error ? e.body.error : e.message;
    const err = new Error(msg);
    err.status = e.status;
    throw err;
  }
}

export const health = () => call('/health', {});
export const byCode = code => call('/api/code', { code }, { ttl: 7 * store.DAY, key: 'code.' + code }).then(r => r.issues || []);
export const search = ({ series, number, year }) =>
  call('/api/search', { series, number, year }, { ttl: store.DAY, key: `search.${series.toLowerCase()}|${number || ''}|${year || ''}` }).then(r => r.issues || []);
export const issue = id => call('/api/issue', { id }, { ttl: 7 * store.DAY, key: 'issue.' + id }).then(r => r.issue);
export const prices = (ctx, { force = false } = {}) => {
  const key = `prices.${ctx.series.toLowerCase()}|${ctx.number || ''}|${ctx.year || ''}|${ctx.volume || ''}|${ctx.trade ? 1 : 0}`;
  if (force) store.del('c.api.' + key);
  return call('/api/prices', { ...ctx, trade: ctx.trade ? 1 : '' }, { ttl: store.HOUR, key });
};
