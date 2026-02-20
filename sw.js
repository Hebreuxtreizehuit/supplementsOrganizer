const CACHE = "supporg-cache-v7";
const ASSETS = [
  "./",
  "./index.html?v=7",
  "./styles.css?v=7",
  "./app.js?v=7",
  "./manifest.json?v=7",
  "./icons/icon-192.png?v=7",
  "./icons/icon-512.png?v=7"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k===CACHE?null:caches.delete(k)))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return cached || fetch(e.request).then((resp) => {
        if (e.request.method === "GET" && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        }
        return resp;
      }).catch(() => cached);
    })
  );
});