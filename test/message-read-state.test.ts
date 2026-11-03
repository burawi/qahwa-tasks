import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { MessageReadService } from "../src/server/message-read-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import type { Config } from "../src/server/config.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-unread-"));
  const config: Config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir, backupDir: join(dataDir, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const reads = new MessageReadService(database);
  const add = (id: string, role = "assistant", ownerType = "orchestrator", ownerId = "main", metadata: unknown = null, item = id) => {
    database.db.prepare(`INSERT OR IGNORE INTO chat_messages
      (id, owner_type, owner_id, codex_item_id, role, body, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerType, ownerId, item, role, `Message ${id}`, JSON.stringify(metadata), "2026-10-28T10:00:00.000Z");
  };
  return { config, database, reads, add };
}

test("only visible assistant replies count once; read IDs are duplicate-safe and owner-scoped", () => {
  const f = fixture();
  try {
    f.add("reply"); f.add("duplicate", "assistant", "orchestrator", "main", null, "reply");
    f.add("user", "user"); f.add("observation", "system");
    f.add("hidden", "assistant", "orchestrator", "main", { queueScheduling: true });
    f.add("other", "assistant", "task", "other");
    f.add("other-orchestrator", "assistant", "orchestrator", "other");
    assert.deepEqual(f.reads.unread("orchestrator", "main"), { unreadCount: 1, unreadMessageIds: ["reply"] });
    assert.equal(f.reads.markRead("orchestrator", "main", ["user", "observation", "hidden", "other", "other-orchestrator", "missing"]).unreadCount, 1);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM chat_message_reads").get().n, 0);
    assert.equal(f.reads.markRead("orchestrator", "main", ["reply", "reply"]).unreadCount, 0);
    f.reads.markRead("orchestrator", "main", ["reply"]);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM chat_message_reads").get().n, 1);
    assert.equal(f.reads.unread("task", "other").unreadCount, 1);
  } finally { f.database.close(); }
});

test("acknowledgement covers only observed IDs and survives database reopen and history edits", () => {
  const f = fixture();
  f.add("first");
  const observed = f.reads.unread("orchestrator", "main").unreadMessageIds;
  f.add("arrived-later");
  assert.deepEqual(f.reads.markRead("orchestrator", "main", observed).unreadMessageIds, ["arrived-later"]);
  f.database.db.prepare("UPDATE chat_messages SET body = 'Edited' WHERE id = 'first'").run();
  f.database.close();
  const reopened = new AppDatabase(f.config);
  try {
    const reads = new MessageReadService(reopened);
    assert.deepEqual(reads.unread("orchestrator", "main").unreadMessageIds, ["arrived-later"]);
    // Cleaning history cascades receipts, with no watermark to swallow new replies.
    reopened.db.prepare("DELETE FROM chat_messages WHERE owner_type = 'orchestrator'").run();
    assert.equal(reads.unread("orchestrator", "main").unreadCount, 0);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM chat_message_reads").get().n, 0);
    reopened.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES ('fresh', 'orchestrator', 'main', 'assistant', 'New session', 'now')").run();
    assert.deepEqual(reads.unread("orchestrator", "main").unreadMessageIds, ["fresh"]);
  } finally { reopened.close(); }
});

test("read input is bounded and rejects malformed IDs without changing receipts", () => {
  const f = fixture(); f.add("reply");
  try {
    for (const input of [undefined, null, "reply", [null], [42], [""], ["x".repeat(201)], Array(1001).fill("reply")]) {
      assert.throws(() => f.reads.markRead("orchestrator", "main", input), { code: "invalid_message_ids" });
    }
    assert.equal(f.reads.unread("orchestrator", "main").unreadCount, 1);
  } finally { f.database.close(); }
});

test("authenticated paired devices share receipts; polling and full history never mark read", async () => {
  const f = fixture(); f.add("one"); f.add("two");
  const headers = ["desktop", "phone"].map((id) => {
    f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES (?, ?, '', 'now', 'now')").run(id, id);
    return { authorization: `Bearer ${new AuthService(f.database, 365).createSession("test", "127.0.0.1", id).token}`, origin: f.config.publicBaseUrl };
  });
  const app = await buildApp(f.config, f.database);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/orchestrator/unread" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/orchestrator/read", payload: { messageIds: ["one"] } })).statusCode, 401);
    for (const url of ["/api/orchestrator", "/api/orchestrator?poll=1", "/api/orchestrator/unread"]) {
      assert.equal((await app.inject({ method: "GET", url, headers: headers[0] })).statusCode, 200);
    }
    const unread = async (device: number) => (await app.inject({ method: "GET", url: "/api/orchestrator/unread", headers: headers[device] })).json().readState;
    assert.equal((await unread(0)).unreadCount, 2);
    const invalid = await app.inject({ method: "POST", url: "/api/orchestrator/read", headers: headers[0], payload: {} });
    assert.equal(invalid.statusCode, 400);
    const acknowledged = await app.inject({ method: "POST", url: "/api/orchestrator/read", headers: headers[0], payload: { messageIds: ["one"] } });
    assert.equal(acknowledged.statusCode, 200, acknowledged.body);
    assert.deepEqual(await unread(1), { unreadCount: 1, unreadMessageIds: ["two"] });
    await app.inject({ method: "POST", url: "/api/orchestrator/read", headers: headers[1], payload: { messageIds: ["two"] } });
    assert.equal((await unread(0)).unreadCount, 0);
  } finally { await app.close(); }
});
