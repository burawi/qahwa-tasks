import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachmentService, ATTACHMENT_LIMITS, ATTACHMENT_ROOT } from "../src/server/attachment-service.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-attachments-test-"));
  const config: Config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir, backupDir: join(dataDir, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const timestamp = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device-a', 'A', '', ?, ?)").run(timestamp, timestamp);
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device-b', 'B', '', ?, ?)").run(timestamp, timestamp);
  return { database, service: new AttachmentService(database, join(dataDir, "attachment-storage")) };
}

test("temporary attachments validate names, chunks, ownership, completion, and expiry", () => {
  const { database, service } = fixture();
  try {
    assert.equal(ATTACHMENT_ROOT, "/tmp/qahwa-tasks-attachments");
    assert.throws(() => service.initiate("task", "task-a", "device-a", { filename: "../escape.txt", size: 1 }), /unsafe/);
    assert.throws(() => service.initiate("task", "task-a", "device-a", { filename: "large.bin", size: ATTACHMENT_LIMITS.fileBytes + 1 }), /100 MiB/);

    const created = service.initiate("task", "task-a", "device-a", { filename: "notes.txt", mediaType: "text/plain", size: 6 });
    assert.throws(() => service.appendChunk(created.id, "device-b", 0, Buffer.from("abc")), /not found/);
    assert.throws(() => service.appendChunk(created.id, "device-a", 1, Buffer.from("abc")), /out of order/);
    assert.deepEqual(service.appendChunk(created.id, "device-a", 0, Buffer.from("abc")), { receivedSize: 3, size: 6 });
    assert.throws(() => service.complete(created.id, "device-a"), /declared size/);
    service.appendChunk(created.id, "device-a", 1, Buffer.from("def"));
    const completed = service.complete(created.id, "device-a");
    assert.equal(completed.status, "available");
    assert.throws(() => service.prepareForMessage("task", "task-b", "device-a", [created.id]), /does not belong/);
    const prepared = service.prepareForMessage("task", "task-a", "device-a", [created.id]);
    assert.equal(readFileSync(prepared[0]!.path, "utf8"), "abcdef");

    database.db.prepare("UPDATE attachment_uploads SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", created.id);
    assert.equal(service.cleanupStale(), 1);
    assert.equal(existsSync(prepared[0]!.path), false);
    assert.throws(() => service.resolveDownload("task", "task-a", created.id), /expired/);
  } finally {
    service.close();
    database.close();
  }
});

test("attachment-only message metadata can retain an expired-file state", () => {
  const { database, service } = fixture();
  try {
    const created = service.initiate("orchestrator", "main", "device-a", { filename: "empty.dat", size: 0 });
    const completed = service.complete(created.id, "device-a");
    const messageId = "message-a";
    database.db.prepare(`INSERT INTO chat_messages (id, owner_type, owner_id, role, body, metadata_json, created_at)
      VALUES (?, 'orchestrator', 'main', 'user', '', ?, ?)`)
      .run(messageId, JSON.stringify({ attachments: [completed] }), new Date().toISOString());
    service.attachToMessage([created.id], messageId);
    assert.throws(() => service.remove(created.id, "device-a"), /cannot be removed/);
    database.db.prepare("UPDATE attachment_uploads SET status = 'expired' WHERE id = ?").run(created.id);
    const decorated = service.decorateMessage({
      id: messageId, ownerType: "orchestrator", ownerId: "main", role: "user", body: "", itemId: null,
      metadata: { attachments: [completed] }, createdAt: new Date().toISOString(),
    });
    assert.equal(decorated.metadata?.attachments?.[0]?.status, "expired");
  } finally {
    service.close();
    database.close();
  }
});

test("new uploads use application storage and legacy uploads keep working until normal expiry", () => {
  const { database, service: original } = fixture();
  original.close();
  const legacyRoot = join(database.dataDir, "legacy-tmpfs");
  const legacy = new AttachmentService(database, legacyRoot, legacyRoot);
  const old = legacy.initiate("task", "task-a", "device-a", { filename: "old.txt", size: 3 });
  legacy.appendChunk(old.id, "device-a", 0, Buffer.from("old"));
  legacy.complete(old.id, "device-a");
  const partial = legacy.initiate("task", "task-a", "device-a", { filename: "partial.txt", size: 6 });
  legacy.appendChunk(partial.id, "device-a", 0, Buffer.from("old"));
  legacy.close();
  let service = new AttachmentService(database, undefined, legacyRoot);
  try {
    assert.equal(service.root, join(database.dataDir, "attachments"));
    const current = service.initiate("orchestrator", "main", "device-a", { filename: "new.txt", size: 3 });
    service.appendChunk(current.id, "device-a", 0, Buffer.from("new"));
    service.complete(current.id, "device-a");
    assert.equal(existsSync(join(legacyRoot, current.id)), false);
    const currentPath = service.resolveDownload("orchestrator", "main", current.id).path;
    assert.equal(currentPath, join(service.root, current.id, "data"));
    assert.equal(statSync(service.root).mode & 0o777, 0o700);
    assert.equal(statSync(currentPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(service.resolveDownload("task", "task-a", old.id).path, "utf8"), "old");
    service.appendChunk(partial.id, "device-a", 1, Buffer.from("new"));
    service.complete(partial.id, "device-a");
    assert.equal(readFileSync(service.resolveDownload("task", "task-a", partial.id).path, "utf8"), "oldnew");
    service.close();
    service = new AttachmentService(database, undefined, legacyRoot);
    for (const [type, owner, id, content] of [["task", "task-a", old.id, "old"], ["orchestrator", "main", current.id, "new"]] as const) {
      assert.equal(readFileSync(service.resolveDownload(type, owner, id).path, "utf8"), content);
      assert.throws(() => service.prepareForMessage(type, owner, "device-b", [id]), /does not belong/);
    }
    service.retainForPendingMessage([old.id]);
    assert.equal(readFileSync(service.resolveDownload("task", "task-a", old.id).path, "utf8"), "old");
    database.db.prepare("UPDATE attachment_uploads SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal(service.cleanupStale(), 3);
    assert.equal(existsSync(currentPath), false);
    assert.equal(existsSync(join(legacyRoot, old.id)), false);
    assert.equal(existsSync(join(database.dataDir, "pending-attachments", old.id)), false);
  } finally { service.close(); database.close(); }
});
