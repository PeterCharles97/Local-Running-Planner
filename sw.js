// Rolling Training Platform — service worker
// Strategy: stale-while-revalidate.
//   • Serve the cached copy instantly (works fully offline).
//   • At the same time, fetch the latest version in the background and update
//     the cache — so changes pushed to GitHub Pages appear on the NEXT open.
// localStorage (the athlete's plan data) is untouched by any of this.
const CACHE = 'rtp-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(['./'])).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((cached) => {
        const network = fetch(e.request)
          .then((res) => {
            if (res && res.ok) cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => cached); // offline: fall back to cache
        // Serve cache immediately if we have it; otherwise wait for network.
        return cached || network;
      })
    )
  );
});
