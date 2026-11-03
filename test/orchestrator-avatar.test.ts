import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_USER_AVATAR_BYTES } from "../src/domain/user-avatar.js";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import { createBackup } from "../src/server/backup.js";
import { AppDatabase } from "../src/server/database.js";
import { getOrchestratorAvatar, orchestratorAvatarImage } from "../src/server/orchestrator-avatar.js";
import { getUserAvatar, saveUserAvatar } from "../src/server/user-avatar.js";
import { projectLogoPng } from "./helpers/project-logo.js";

test("orchestrator avatar API rejects unauthorized, unsafe and oversized uploads without replacing the saved image", async () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-avatar-security-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365);
  const timestamp = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices(id, name, public_key, created_at, last_seen_at) VALUES ('phone', 'phone', '', ?, ?)").run(timestamp, timestamp);
  const headers = { authorization: `Bearer ${auth.createSession("phone", "127.0.0.1", "phone").token}`, origin: config.publicBaseUrl, "content-type": "image/png" };
  const app = await buildApp(config, database);
  const url = "/api/settings/orchestrator/avatar";
  try {
    assert.deepEqual((await app.inject({ method: "GET", url, headers })).json(), { avatar: null });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      assert.equal((await app.inject({ method, url, ...(method === "PUT" ? { headers: { "content-type": "image/png" }, payload: projectLogoPng(1024) } : {}) })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "GET", url: `${url}/image` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `${url}/image`, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "PUT", url, headers: { ...headers, origin: "https://elsewhere.invalid" }, payload: projectLogoPng(1024) })).statusCode, 403);
    const formerlyRejected = await app.inject({ method: "PUT", url, headers, payload: projectLogoPng(2 * 1024 * 1024 + 1) });
    assert.equal(formerlyRejected.statusCode, 200, formerlyRejected.body);
    const png = projectLogoPng(MAX_USER_AVATAR_BYTES);
    const saved = await app.inject({ method: "PUT", url, headers, payload: png });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().avatar.size, MAX_USER_AVATAR_BYTES);
    assert.ok(saved.body.length < 400, "Metadata responses do not include image bytes");
    const original = saved.json();
    for (const [type, payload, status] of [
      ["image/png", Buffer.alloc(0), 400],
      ["image/png", Buffer.from("<svg onload='alert(1)'/>"), 400],
      ["image/gif", Buffer.from("GIF89a"), 400],
      ["image/jpeg", png, 400],
      ["application/octet-stream", png, 400],
      ["image/png", projectLogoPng(MAX_USER_AVATAR_BYTES + 1), 413],
    ] as const) {
      const rejected = await app.inject({ method: "PUT", url, headers: { ...headers, "content-type": type }, payload });
      assert.equal(rejected.statusCode, status, rejected.body);
      assert.deepEqual((await app.inject({ method: "GET", url, headers })).json(), original);
    }
    const downloaded = await app.inject({ method: "GET", url: original.avatar.url, headers });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.rawPayload, png);
    assert.equal(downloaded.headers["content-type"], "image/png");
    assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
    assert.equal(downloaded.headers["cache-control"], "no-store");
    assert.match(String(downloaded.headers["content-security-policy"]), /img-src[^;]*blob:/);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("orchestrator avatar paired devices share replacement/reset, preserve avatars after clean and restart, and include bytes in backups", async () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-avatar-persistence-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365);
  const timestamp = new Date().toISOString();
  const devices = ["phone", "desktop"].map((id) => {
    database.db.prepare("INSERT INTO paired_devices(id, name, public_key, created_at, last_seen_at) VALUES (?, ?, '', ?, ?)").run(id, id, timestamp, timestamp);
    return { authorization: `Bearer ${auth.createSession(id, "127.0.0.1", id).token}`, origin: config.publicBaseUrl };
  });
  const url = "/api/settings/orchestrator/avatar";
  let app = await buildApp(config, database);
  try {
    const png = projectLogoPng(1024);
    const upload = async (headers: typeof devices[number]) => {
      const result = await app.inject({ method: "PUT", url, headers: { ...headers, "content-type": "image/png" }, payload: png });
      assert.equal(result.statusCode, 200, result.body); return result.json().avatar;
    };
    const personal = saveUserAvatar(database, png, "image/png");
    const first = await upload(devices[0]!);
    assert.deepEqual(getUserAvatar(database), personal, "Orchestrator upload preserves the personal avatar");
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[1] })).json().avatar, first);
    const replaced = await upload(devices[1]!);
    assert.notEqual(replaced.version, first.version);
    assert.notEqual(replaced.url, first.url);
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[0] })).json().avatar, replaced);
    database.setSetting("orchestrator_preferences", JSON.stringify({ name: "Bean", customInstructions: "Keep this." }));
    database.db.prepare("INSERT INTO chat_messages(id, owner_type, owner_id, role, body, created_at) VALUES ('old', 'orchestrator', 'main', 'user', 'hello', ?)").run(timestamp);
    assert.equal((await app.inject({ method: "POST", url: "/api/orchestrator/clean", headers: devices[1] })).statusCode, 200);
    assert.deepEqual(getOrchestratorAvatar(database), replaced);
    const backup = await createBackup(database, config.backupDir);
    const snapshot = new AppDatabase(config, backup);
    try { assert.deepEqual(getOrchestratorAvatar(snapshot), replaced); assert.deepEqual(orchestratorAvatarImage(snapshot).bytes, png); }
    finally { snapshot.close(); }
    await app.close();
    const reopened = new AppDatabase(config);
    app = await buildApp(config, reopened);
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[0] })).json().avatar, replaced);
    assert.deepEqual((await app.inject({ method: "GET", url: replaced.url, headers: devices[1] })).rawPayload, png);
    assert.equal((await app.inject({ method: "DELETE", url, headers: devices[1] })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[0] })).json(), { avatar: null });
    assert.equal((await app.inject({ method: "GET", url: replaced.url, headers: devices[0] })).statusCode, 404);
    assert.equal(reopened.setting("orchestrator_avatar_image"), null);
    assert.deepEqual(getUserAvatar(reopened), personal, "Orchestrator reset preserves the personal avatar");
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/settings/orchestrator", headers: devices[0] })).json().settings, { name: "Bean", customInstructions: "Keep this." });
    assert.equal((await app.inject({ method: "DELETE", url, headers: devices[0] })).statusCode, 200, "Reset is idempotent");
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
