const CACHE = "qahwa-tasks-v4";
const STATIC_ASSETS = ["/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const legacyCaches = keys.filter((key) => key.startsWith("qahwa-tasks-") && key !== CACHE);
    await Promise.all(legacyCaches.map((key) => caches.delete(key)));
    await self.clients.claim();
    if (legacyCaches.length > 0) {
      const clients = await self.clients.matchAll({ type: "window" });
      await Promise.all(clients.map((client) => client.navigate(client.url)));
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => new Response(
      "<!doctype html><meta name=\"viewport\" content=\"width=device-width\"><title>Qahwa Tasks</title>" +
      "<main><h1>Qahwa Tasks</h1><p>You are offline. Reconnect and reload to continue.</p></main>",
      { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
    )));
    return;
  }

  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
