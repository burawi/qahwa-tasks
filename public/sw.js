const CACHE = "qahwa-tasks-v19";
const STYLE_RECOVERY = "v19";
const STATIC_ASSETS = ["/theme.js?v=1", "/manifest.webmanifest", "/icons/qahwa-violet-v1.svg", "/icons/qahwa-violet-v1-192.png", "/icons/qahwa-violet-v1-512.png", "/icons/qahwa-violet-v1-maskable-512.png"];

self.addEventListener("push", (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || typeof payload.title !== "string" || typeof payload.body !== "string") return;
  let url = "/";
  try {
    const target = new URL(payload.url, self.location.origin);
    if (target.origin === self.location.origin && target.pathname.startsWith("/tasks/")) url = target.pathname;
  } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/icons/qahwa-violet-v1-192.png",
    tag: typeof payload.tag === "string" ? payload.tag : "qahwa-task-idle",
    renotify: false,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL("/", self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url, self.location.origin);
      if (candidate.origin === self.location.origin && candidate.pathname.startsWith("/tasks/")) target = candidate;
    } catch {}
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find(window => new URL(window.url).origin === target.origin);
    if (client) {
      try { await client.navigate(target.href); return await client.focus(); } catch {}
    }
    return self.clients.openWindow(target.href);
  })());
});

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
        if (recoveryUrl.searchParams.get("recovery") === "v19") return;
        recoveryUrl.searchParams.set("recovery", "v19");
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

  if (url.pathname === "/manifest.webmanifest") {
    // Installed apps must see identity changes even while this worker controls
    // the page. Keep the last successful manifest for offline use only.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = "/manifest.webmanifest";
      try {
        const response = await fetch(event.request, { cache: "no-store" });
        if (response.ok) {
          // A failed cache write must not turn a healthy network response into
          // an error or replace it with a stale identity.
          try { await cache.put(key, response.clone()); } catch {}
          return response;
        }
        return (await cache.match(key)) || response;
      } catch {
        return (await cache.match(key)) || new Response("Manifest unavailable", { status: 503 });
      }
    })());
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => new Response(
      "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">" +
      "<meta name=\"theme-color\" content=\"#14101e\" media=\"(prefers-color-scheme: dark)\"><meta name=\"theme-color\" content=\"#f7f5fc\" media=\"(prefers-color-scheme: light)\">" +
      "<script src=\"/theme.js?v=1\"></script><meta name=\"application-name\" content=\"Qahwa\"><link rel=\"manifest\" href=\"/manifest.webmanifest\"><link rel=\"icon\" href=\"/icons/qahwa-violet-v1.svg\" type=\"image/svg+xml\"><title>Qahwa</title>" +
      "<style>:root{color-scheme:light;background:#f7f5fc}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f5fc;color:#231a35;font:16px/1.6 system-ui}main{max-width:28rem;margin:24px;padding:32px;border:1px solid #e4ddef;border-top:4px solid #7138e8;border-radius:24px;background:#fff}h1{letter-spacing:-.04em}:root[data-theme=dark]{color-scheme:dark;background:#14101e}:root[data-theme=dark] body{background:#14101e;color:#f5f0ff}:root[data-theme=dark] main{background:#1e182b;border-color:#3b314e;border-top-color:#bca1ff}</style><main><h1>Qahwa</h1><p>You are offline. Reconnect and reload to continue.</p></main></html>",
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

  if (STATIC_ASSETS.includes(url.pathname) || STATIC_ASSETS.includes(url.pathname + url.search)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
