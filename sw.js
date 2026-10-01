/* JET Brasília Monitor — Service Worker
   Estratégia: rede primeiro para evitar versões antigas após atualizações.
*/

const CACHE_NAME = "jet-brasilia-monitor-v4";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith("jet-brasilia-monitor-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const freshRequest = new Request(request, { cache: "no-store" });
    const response = await fetch(freshRequest);

    if (response && response.ok) {
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (request.mode === "navigate") {
      const index = await cache.match("/index.html") || await cache.match("/");
      if (index) return index;
    }

    throw error;
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});
