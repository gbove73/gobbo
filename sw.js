const CACHE = 'gobbo-v8';
const FILES = ['./', 'index.html', 'effects.js', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
// librerie e modello non cambiano mai: si scaricano una volta e poi si usano dalla cache
const IMMUTABLE = /\/(vendor|models)\//;

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  // la cache delle librerie sopravvive agli aggiornamenti dell'app
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'gobbo-libs').map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (IMMUTABLE.test(url.pathname)) {
    e.respondWith(caches.open('gobbo-libs').then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) c.put(e.request, r.clone()); return r;
    }))));
    return;
  }
  // app: rete prima (per ricevere aggiornamenti), cache se offline
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
