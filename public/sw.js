'use strict';

// Bump this when any shell file changes so clients pick up the new version.
const CACHE = 'wardogs-shell-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. API calls (cross-origin) always go to the
  // network and are never cached, so no Steam data is stored on the device.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations: network first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // Static assets: cache first.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
