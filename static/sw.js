// Service Worker for Pickle Flow PWA
// Supports offline + online with smart caching

const CACHE_NAME = 'pickle-flow-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/static/app.js',
  '/static/style.css',
  '/manifest.json',
  '/favicon.ico'
];

// Install: cache static assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Fallback if some assets don't exist
        return cache.addAll(STATIC_ASSETS.filter(url => !url.includes('favicon')));
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  e.waitUntil(clients.claim());
});

// Fetch: network-first for API, cache-first for static
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // API calls: network-first with fallback to offline cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          // Cache successful API responses for offline use
          if (res.ok) {
            const cache_res = res.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, cache_res);
            });
          }
          return res;
        })
        .catch(() => {
          // Offline: return cached response if available
          return caches.match(request).then((cached) => {
            if (cached) {
              return cached;
            }
            // Return offline placeholder
            return new Response(
              JSON.stringify({ error: 'Offline', cached: true }),
              { headers: { 'Content-Type': 'application/json' } }
            );
          });
        })
    );
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request)
        .then((res) => {
          if (!res || res.status !== 200 || res.type === 'error') {
            return res;
          }
          // Cache successful responses
          const cache_res = res.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, cache_res);
          });
          return res;
        })
        .catch(() => {
          // Fallback for offline static assets
          return caches.match('/index.html');
        });
    })
  );
});
