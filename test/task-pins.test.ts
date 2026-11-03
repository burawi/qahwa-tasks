import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-pins-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.example.test", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Pins", prefix: "PIN", rootDirectory: root }, "user");
  const first = tasks.createTask({ projectId: project.id, title: "Older conversation", status: "todo" }, "user");
  const second = tasks.createTask({ projectId: project.id, title: "Latest conversation", status: "todo" }, "user");
  for (const [task, stamp] of [[first, "2026-10-01T00:00:00Z"], [second, "2026-10-02T00:00:00Z"]] as const) {
    database.db.prepare("INSERT INTO chat_messages (id,owner_type,owner_id,role,body,created_at) VALUES (?,'task',?,'assistant','Unread reply',?)").run(task.id, task.id, stamp);
  }
  return { root, config, database, tasks, project, first, second };
}

test("pins migrate without pinning existing tasks and survive database reopen", () => {
  const f = fixture();
  let database = f.database;
  try {
    database.db.exec("ALTER TABLE tasks DROP COLUMN pinned_at");
    database.close(); database = new AppDatabase(f.config);
    let tasks = new TaskService(database);
    assert.equal(tasks.getTask(f.first.id).pinnedAt, null);
    assert.equal(tasks.getTask(f.second.id).pinnedAt, null);
    const before = tasks.getTask(f.first.id);
    const pinned = tasks.setPinned(f.first.humanId, true);
    assert.ok(pinned.pinnedAt);
    assert.equal(tasks.setPinned(f.first.id, true).pinnedAt, pinned.pinnedAt, "Repeated pins are idempotent");
    assert.deepEqual({ ...pinned, pinnedAt: null }, before, "Only presentation preference changes");
    database.close(); database = new AppDatabase(f.config); tasks = new TaskService(database);
    assert.equal(tasks.getTask(f.first.id).pinnedAt, pinned.pinnedAt);
    assert.equal(tasks.getTask(f.second.id).pinnedAt, null);
    assert.equal(tasks.createTask({ projectId: f.project.id, title: "New conversation" }, "user").pinnedAt, null);
    assert.equal(tasks.setPinned(f.first.id, false).pinnedAt, null);
  } finally { if (database.db.open) database.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("pins group conversations first without changing priority, unread receipts or project/history filters", () => {
  const f = fixture();
  try {
    const conversations = () => f.tasks.listTasks({ tab: "active", order: "conversation" });
    const queue = f.tasks.listTasks({ tab: "active" });
    assert.deepEqual(conversations().map(t => t.id), [f.second.id, f.first.id]);
    f.tasks.setPinned(f.first.id, true);
    assert.deepEqual(conversations().map(t => t.id), [f.first.id, f.second.id]);
    assert.equal(conversations()[0]!.conversation!.unreadCount, 1);
    assert.deepEqual(f.tasks.listTasks({ tab: "active" }).map(({ pinnedAt, ...task }) => task), queue.map(({ pinnedAt, ...task }) => task));
    f.tasks.setPinned(f.second.id, true);
    assert.deepEqual(conversations().map(t => t.id), [f.second.id, f.first.id], "Recency is retained within each pin group");
    const other = f.tasks.createProject({ name: "Other", prefix: "OTH", rootDirectory: f.root }, "user");
    assert.deepEqual(f.tasks.listTasks({ tab: "active", projectId: other.id, order: "conversation" }), []);
    f.tasks.transition(f.first.id, { to: "closed", outcome: "cancelled" }, "user");
    assert.deepEqual(conversations().map(t => t.id), [f.second.id]);
    assert.ok(f.tasks.listTasks({ tab: "closed", order: "conversation" })[0]!.pinnedAt);
    f.tasks.setPinned(f.second.id, false);
    assert.equal(conversations()[0]!.pinnedAt, null);
  } finally { f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("paired devices share pins; the API requires authentication and a boolean", async () => {
  const f = fixture();
  const headers = ["phone", "desktop"].map(id => {
    f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES (?,?,'','now','now')").run(id, id);
    return { authorization: `Bearer ${new AuthService(f.database, 365).createSession("test", "127.0.0.1", id).token}`, origin: f.config.publicBaseUrl };
  });
  const app = await buildApp(f.config, f.database);
  const url = `/api/tasks/${f.first.humanId}/pin`;
  try {
    assert.equal((await app.inject({ method: "PUT", url, payload: { pinned: true } })).statusCode, 401);
    for (const pinned of [undefined, null, "true", 1, {}, []]) {
      const response = await app.inject({ method: "PUT", url, headers: headers[0], payload: { pinned } });
      assert.equal(response.statusCode, 400, response.body);
    }
    for (const [device, pinned] of [[0, true], [1, false]] as const) {
      const response = await app.inject({ method: "PUT", url, headers: headers[device], payload: { pinned } });
      assert.equal(response.statusCode, 200, response.body);
      const other = await app.inject({ method: "GET", url: "/api/tasks?tab=active&order=conversation", headers: headers[1 - device] });
      assert.equal(other.statusCode, 200, other.body);
      assert.equal(Boolean(other.json().tasks.find((t: { id: string }) => t.id === f.first.id).pinnedAt), pinned);
      assert.equal(f.tasks.getTask(f.second.id).pinnedAt, null);
    }
    assert.equal((await app.inject({ method: "PUT", url: "/api/tasks/missing/pin", headers: headers[0], payload: { pinned: true } })).statusCode, 404);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});
