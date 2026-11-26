// Lets ComicScan open offline and keeps the barcode reader cached.
const VERSION = 'comicscan-v2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/comic.css',
  'js/app.js', 'js/api.js', 'js/barcode.js', 'js/cover.js', 'js/config.js', 'js/net.js', 'js/store.js',
  'vendor/zxing/zxing-reader.js', 'vendor/zxing/zxing_reader.wasm',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/no-cover.svg',
];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'comicscan-cdn').map(k => caches.delete(k))))
  .then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('projectnaptha.com')) {
    e.respondWith(caches.open('comicscan-cdn').then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
  }
});
