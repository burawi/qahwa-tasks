import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { ATTACHMENT_LIMITS } from "../src/server/attachment-service.js";

test("both chats upload 25 concurrent files, send together, and download every file from saved history", async () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-upload-storage-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const timestamp = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices(id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
  const auth = new AuthService(database, 365);
  const headers = { authorization: `Bearer ${auth.createSession("Test", "127.0.0.1", "device").token}`, origin: config.publicBaseUrl };
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Uploads", prefix: "UPL", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Upload acceptance", status: "todo" }, "user");
  const app = await buildApp(config, database);
  try {
    const content = Buffer.alloc(ATTACHMENT_LIMITS.chunkBytes + 37, 0x71);
    for (const [base, owner] of [[`/api/tasks/${task.id}`, task.id], ["/api/orchestrator", "main"]]) {
      // Hold only the isolated sessions busy: Send exercises durable queueing
      // without starting a model process or performing external work.
      assert.equal((await app.inject({ url: base!, headers })).statusCode, 200);
      database.db.prepare("UPDATE agent_sessions SET run_state = 'waiting' WHERE owner_id = ?").run(owner!);
      // Start the entire batch before completing any upload. This catches both
      // per-message limits and limits on simultaneous upload initiation.
      const starts = await Promise.all(Array.from({ length: 25 }, (_, i) => app.inject({
        method: "POST", url: `${base}/attachments`, headers,
        payload: { filename: `context-${i}.bin`, mediaType: "application/octet-stream", size: content.length },
      })));
      starts.forEach(response => assert.equal(response.statusCode, 201, response.body));
      const ids = starts.map(response => response.json().attachment.id as string);
      for (const id of ids) {
        assert.equal((await app.inject({ method: "PUT", url: `/api/attachments/${id}/chunks/0`, headers: { "content-type": "application/octet-stream" }, payload: content.subarray(0, ATTACHMENT_LIMITS.chunkBytes) })).statusCode, 401);
        for (let offset = 0, chunk = 0; offset < content.length; offset += ATTACHMENT_LIMITS.chunkBytes, chunk++) {
          const appended = await app.inject({ method: "PUT", url: `/api/attachments/${id}/chunks/${chunk}`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: content.subarray(offset, offset + ATTACHMENT_LIMITS.chunkBytes) });
          assert.equal(appended.statusCode, 200, appended.body);
        }
        const completed = await app.inject({ method: "POST", url: `/api/attachments/${id}/complete`, headers });
        assert.equal(completed.statusCode, 200, completed.body);
        assert.deepEqual(readFileSync(join(root, "attachments", id, "data")), content);
      }
      const before = database.db.prepare("SELECT COUNT(*) AS count FROM chat_messages").get();
      assert.deepEqual(before, { count: base!.startsWith("/api/tasks/") ? 0 : 1 }, "Uploading does not send a message");
      const duplicate = await app.inject({ method: "POST", url: `${base}/messages`, headers, payload: { message: "", attachmentIds: [ids[0], ids[0]] } });
      assert.equal(duplicate.statusCode, 400, duplicate.body);
      assert.match(duplicate.json().message, /must be unique/);
      const sent = await app.inject({ method: "POST", url: `${base}/messages`, headers, payload: { message: "", attachmentIds: ids } });
      assert.equal(sent.statusCode, 202, sent.body);
      assert.deepEqual(sent.json().workspace.messages.at(-1).metadata.attachments.map((file: any) => file.id), ids);
      const saved = await app.inject({ url: base!.startsWith("/api/tasks/") ? `${base}/workspace` : base!, headers });
      assert.equal(saved.statusCode, 200, saved.body);
      const stored = saved.json().workspace.messages.at(-1).metadata.attachments;
      assert.equal(stored.length, 25);
      for (const attachment of stored) {
        const id = attachment.id;
        assert.deepEqual(readFileSync(join(root, "pending-attachments", id, "data")), content);
        const pieces: Buffer[] = [];
        for (let offset = 0; offset < content.length; offset += ATTACHMENT_LIMITS.chunkBytes) {
          const downloaded = await app.inject({ url: `${attachment.previewUrl}?offset=${offset}`, headers });
          assert.equal(downloaded.statusCode, 206, downloaded.body);
          pieces.push(downloaded.rawPayload);
        }
        assert.deepEqual(Buffer.concat(pieces), content);
        assert.equal((await app.inject({ url: attachment.previewUrl })).statusCode, 401);
        const opposite = base!.startsWith("/api/tasks/") ? "/api/orchestrator" : `/api/tasks/${task.id}`;
        assert.equal((await app.inject({ url: `${opposite}/attachments/${id}`, headers })).statusCode, 410);
      }
    }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
