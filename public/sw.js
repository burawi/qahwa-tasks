const CACHE = "qahwa-tasks-v12";
const STYLE_RECOVERY = "v12";
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
      clients.forEach((client) => {
        const recoveryUrl = new URL(client.url);
        if (recoveryUrl.searchParams.get("recovery") === "v12") return;
        recoveryUrl.searchParams.set("recovery", "v12");
        recoveryUrl.searchParams.set("updated", Date.now().toString());
        // Do not await this promise inside activate. A controlled navigation can
        // wait for activation to finish, which would deadlock the cache purge.
        void client.navigate(recoveryUrl.toString()).catch(() => {});
      });
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

  if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".css")) {
    // Cache Storage and the browser's HTTP cache are independent. v5 marked an
    // empty recovery stylesheet immutable, so deleting Cache Storage alone
    // cannot repair that URL. Fetch a versioned URL that cannot match the
    // poisoned HTTP-cache entry and use it as the stylesheet response.
    url.searchParams.set("qahwa-style", STYLE_RECOVERY);
    event.respondWith(fetch(url.toString()).catch(() => fetch(event.request)));
    return;
  }

  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
