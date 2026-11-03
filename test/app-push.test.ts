import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import webpush from "web-push";
import { AppDatabase } from "../src/server/database.js";
import { AppPushService } from "../src/server/app-push-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-app-push-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.example.test", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const stamp = new Date().toISOString();
  for (const id of ["phone", "desktop", "revoked", "expired"]) database.db.prepare(
    "INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES (?,?, '',?,?)").run(id, id, stamp, stamp);
  const key = createECDH("prime256v1"); key.generateKeys();
  const subscription = (id = "phone"): webpush.PushSubscription => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } });
  return { root, config, database, subscription, close() { if (database.db.open) database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("native push encrypts app payloads with persistent VAPID keys and never exposes the private key in settings", async () => {
  const f = fixture();
  let attempts = 0;
  const push = new AppPushService(f.database, f.config, async (subscription, payload, options) => {
    attempts++;
    const request = webpush.generateRequestDetails(subscription, payload, options);
    assert.equal(request.endpoint, f.subscription().endpoint);
    assert.match(String(request.headers.Authorization), /^vapid /);
    assert.equal(request.headers["Content-Encoding"], "aes128gcm");
    assert.ok(Buffer.isBuffer(request.body));
    assert.ok(!request.body!.includes(Buffer.from("A completed task")), "Wire payload is encrypted");
    assert.equal(options?.timeout, 10_000);
    assert.equal(options?.topic?.length, 32);
    return { statusCode: 201, headers: {}, body: "" };
  });
  try {
    const settings = push.settings("phone");
    assert.equal(settings.subscribed, false);
    assert.deepEqual(Object.keys(settings).sort(), ["publicKey", "subscribed"]);
    push.subscribe("phone", f.subscription());
    assert.equal(push.settings("phone").subscribed, true);
    assert.equal(new AppPushService(f.database, f.config).settings("phone").publicKey, settings.publicKey);
    assert.equal(await push.send({ title: "Task is idle", body: "A completed task", url: "/tasks/IDL-0001", tag: "turn-1" }), 1);
    assert.equal(attempts, 1);
    const persisted = JSON.parse(f.database.setting("app_push_vapid_keys")!);
    assert.ok(persisted.privateKey);
    assert.ok(!JSON.stringify(settings).includes(persisted.privateKey));
  } finally { f.close(); }
});

test("delivery excludes revoked devices, removes expired endpoints and isolates per-device failures", async () => {
  const f = fixture();
  const sent: string[] = [];
  const push = new AppPushService(f.database, f.config, async subscription => {
    sent.push(subscription.endpoint);
    if (subscription.endpoint.endsWith("expired")) throw { statusCode: 410 };
    if (subscription.endpoint.endsWith("desktop")) throw new Error("Temporary network failure");
    return { statusCode: 201, headers: {}, body: "" };
  });
  try {
    for (const id of ["phone", "desktop", "revoked", "expired"]) push.subscribe(id, f.subscription(id));
    f.database.db.prepare("UPDATE paired_devices SET revoked_at='now' WHERE id='revoked'").run();
    assert.equal(await push.send({ title: "Task is idle", body: "Done", url: "/tasks/IDL-0001", tag: "turn-1" }), 1);
    assert.equal(sent.length, 3);
    assert.ok(!sent.some(endpoint => endpoint.endsWith("revoked")));
    assert.equal(push.settings("expired").subscribed, false);
    assert.equal(push.settings("desktop").subscribed, true);
    push.unsubscribe("phone");
    assert.equal(push.settings("phone").subscribed, false);
  } finally { f.close(); }
});

test("paired push routes scope subscriptions to the current device and reject unsafe subscriptions", async () => {
  const f = fixture();
  const app = await buildApp(f.config, f.database);
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "phone").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const url = "/api/notifications/push";
  try {
    for (const method of ["GET", "PUT", "DELETE"] as const) assert.equal((await app.inject({ method, url, ...(method === "PUT" ? { payload: f.subscription() } : {}) })).statusCode, 401);
    const settings = await app.inject({ method: "GET", url, headers });
    assert.equal(settings.statusCode, 200);
    assert.deepEqual(Object.keys(settings.json()).sort(), ["publicKey", "subscribed"]);
    for (const endpoint of ["invalid", "http://fcm.googleapis.com/send/x", "https://localhost/send/x", "https://127.0.0.1/send/x", "https://fcm.googleapis.com.evil.test/send/x", "https://user:pass@fcm.googleapis.com/send/x"]) {
      assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...f.subscription(), endpoint } })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...f.subscription(), keys: { auth: "invalid", p256dh: "invalid" } } })).statusCode, 400);
    const saved = await app.inject({ method: "PUT", url, headers, payload: { ...f.subscription(), deviceId: "desktop" } });
    assert.equal(saved.statusCode, 200, saved.body);
    const push = new AppPushService(f.database, f.config);
    assert.equal(push.settings("phone").subscribed, true);
    assert.equal(push.settings("desktop").subscribed, false);
    assert.throws(() => push.subscribe("desktop", f.subscription()), /another paired device/);
    await app.inject({ method: "DELETE", url, headers });
    assert.equal(push.settings("phone").subscribed, false);
    push.subscribe("phone", f.subscription());
    await app.inject({ method: "POST", url: "/api/devices/phone/revoke", headers });
    assert.equal(push.settings("phone").subscribed, false);
    assert.throws(() => push.subscribe("phone", f.subscription()), /Pair this device/);
  } finally { await app.close(); f.close(); }
});

function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const displayed: Array<{ title: string; options: any }> = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  let focused = 0;
  let windows: any[] = [];
  const self = { location: { origin: "https://tasks.example.test" },
    registration: { showNotification: async (title: string, options: any) => { displayed.push({ title, options }); } },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    clients: { matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } } };
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL });
  return { displayed, opened, navigated, get focused() { return focused; },
    existingWindow() { windows = [{ url: "https://tasks.example.test/orchestrator", navigate: async (url: string) => { navigated.push(url); }, focus: async () => { focused++; } }]; },
    async dispatch(type: string, event: any) { let work = Promise.resolve(); handlers.get(type)!({ ...event, waitUntil: (promise: Promise<void>) => { work = promise; } }); await work; } };
}

test("service worker displays app-branded idle notifications while closed, then opens or focuses the correct task", async () => {
  const w = worker();
  await w.dispatch("push", { data: { json: () => ({ title: "Task is idle", body: "IDL-0001 · A task", url: "/tasks/IDL-0001", tag: "turn-1" }) } });
  assert.equal(w.displayed[0]?.options.icon, "/icons/qahwa-violet-v1-192.png");
  assert.equal(w.displayed[0]?.options.tag, "turn-1");
  assert.equal(w.displayed[0]?.options.renotify, false);
  let closed = 0;
  const notification = { data: w.displayed[0]!.options.data, close: () => { closed++; } };
  await w.dispatch("notificationclick", { notification });
  assert.deepEqual(w.opened, ["https://tasks.example.test/tasks/IDL-0001"]);
  w.existingWindow();
  await w.dispatch("notificationclick", { notification });
  assert.deepEqual(w.navigated, ["https://tasks.example.test/tasks/IDL-0001"]);
  assert.equal(w.focused, 1);
  assert.equal(closed, 2);
});

test("service worker rejects malformed pushes and external notification destinations", async () => {
  const w = worker();
  await w.dispatch("push", { data: { json: () => { throw new Error("invalid JSON"); } } });
  assert.equal(w.displayed.length, 0);
  await w.dispatch("push", { data: { json: () => ({ title: "Task is idle", body: "Done", url: "https://evil.test/tasks/IDL-0001" }) } });
  assert.equal(w.displayed[0]?.options.data.url, "/");
  await w.dispatch("notificationclick", { notification: { close() {}, data: { url: "https://evil.test/tasks/IDL-0001" } } });
  assert.deepEqual(w.opened, ["https://tasks.example.test/"]);
});
