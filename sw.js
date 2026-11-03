const CACHE = 'budget-fcfa-v1';
const ASSETS = ['./', 'index.html', 'styles.css', 'core.js', 'db.js', 'app.js', 'manifest.webmanifest',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/bricolage-grotesque-latin-wght-normal.woff2', 'icons/kita.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  if (request.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(request)));
    return;
  }
  e.respondWith(caches.match(request).then((r) => r || fetch(request)));
});
