const CACHE_NAME = 'speelgoedotheek-v9';
const FILES = ['./index.html', './manifest.json', './icon.svg', './styles.css', './app.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if(response.ok){
        const copy = response.clone();
        return caches.open(CACHE_NAME).then((cache) =>
          cache.put(event.request, copy).then(() => response)
        );
      }
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
  );
});
