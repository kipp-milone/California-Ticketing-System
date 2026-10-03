// Offline support: cache the app shell and the last-viewed tickets (including
// QR codes) so patrons can show tickets at the door without connectivity.
const CACHE = 'ctms-v1';
const SHELL = ['/', '/tickets.html', '/ticket.html', '/css/app.css', '/js/common.js', '/js/tickets.js', '/js/ticket.js', '/icon.svg'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const cacheable = !url.pathname.startsWith('/api/') || /^\/api\/tickets\/[^/]+(\/qr\.svg)?$/.test(url.pathname);
  if (!cacheable) return;
  // Network first, fall back to cache.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: url.pathname.endsWith('.html') || url.pathname === '/' })));
});
