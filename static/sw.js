// Service Worker for Pickle Flow PWA
// Minimal SW - no caching, just passthrough for live data

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', () => {
  // Passthrough - no caching for live data
});
