import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { MessageReadService } from "../src/server/message-read-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import type { Config } from "../src/server/config.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-conversations-"));
  const config: Config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir, backupDir: join(dataDir, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Conversations", prefix: "CON", rootDirectory: dataDir }, "user");
  const create = (title: string, projectId = project.id) => {
    const task = tasks.createTask({ projectId, title, status: "todo" }, "user");
    database.db.prepare("UPDATE tasks SET created_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(task.id);
    return task;
  };
  const add = (id: string, taskId: string, at: string, role = "assistant", body = id, metadata: unknown = null) => {
    database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, metadata_json, created_at) VALUES (?, 'task', ?, ?, ?, ?, ?)")
      .run(id, taskId, role, body, JSON.stringify(metadata), at);
  };
  return { config, database, tasks, project, create, add };
}

test("conversation order follows visible messages across statuses without changing queue rank", () => {
  const f = fixture();
  try {
    const first = f.create("Old conversation"), second = f.create("New reply"), empty = f.create("No messages");
    f.tasks.transition(first.id, { to: "in_progress" }, "user");
    f.add("old", first.id, "2026-10-20T12:00:00.000Z");
    f.add("new", second.id, "2026-10-21T12:00:00.000Z", "assistant", "**Ready**\nfor [review](https://example.com) <!-- qahwa:{} -->");
    f.add("tool", first.id, "2026-10-28T12:00:00.000Z", "system");
    f.add("silent", first.id, "2026-10-28T13:00:00.000Z", "assistant", "Hidden scheduler", { queueScheduling: true });
    f.database.db.prepare("UPDATE tasks SET updated_at = '2026-10-29T12:00:00.000Z' WHERE id = ?").run(empty.id);
    const list = () => f.tasks.listTasks({ tab: "active", order: "conversation" });
    assert.deepEqual(list().map(t => t.id), [second.id, first.id, empty.id]);
    assert.equal(list()[0]!.conversation!.latestMessage!.preview, "Ready for review");
    assert.equal(list()[1]!.conversation!.unreadCount, 1);
    assert.deepEqual(list()[2]!.conversation, { latestMessage: null, unreadCount: 0, activityAt: "2026-10-01T00:00:00.000Z" });
    assert.equal(f.tasks.listTasks({ tab: "active" })[0]!.id, first.id, "Scheduler still uses status/rank order");
    const originalRanks = list().map(t => [t.id, t.rank]);
    new MessageReadService(f.database).markRead("task", second.id, ["new"]);
    assert.equal(list()[0]!.conversation!.unreadCount, 0);
    assert.deepEqual(list().map(t => [t.id, t.rank]), originalRanks);
    // Same timestamp uses insertion order for the last message; user replies also reorder.
    f.add("user", first.id, "2026-10-21T12:00:00.000Z", "user", "Please continue");
    f.add("user-later", first.id, "2026-10-21T12:00:00.000Z", "user", "Latest request");
    assert.equal(list().find(t => t.id === first.id)!.conversation!.latestMessage!.preview, "Latest request");
    assert.deepEqual(list().slice(0, 2).map(t => t.id), [first.id, second.id].sort(), "Equal timestamps have a stable ID tie-breaker");
    f.add("newest-user", first.id, "2026-10-22T12:00:00.000Z", "user");
    assert.equal(list()[0]!.id, first.id);
    assert.equal(list()[0]!.conversation!.latestMessage!.role, "user");
  } finally { f.database.close(); }
});

test("conversation filters keep projects and completed history separate", () => {
  const f = fixture();
  try {
    const other = f.tasks.createProject({ name: "Other", prefix: "OTH", rootDirectory: f.config.dataDir }, "user");
    const active = f.create("Active"), closed = f.create("Closed"), foreign = f.create("Other project", other.id);
    f.tasks.transition(closed.id, { to: "in_progress" }, "user");
    f.tasks.submitForReview(closed.id, { summary: "Completed", validation: ["Checked"] }, "codex");
    f.tasks.transition(closed.id, { to: "closed", outcome: "completed" }, "user");
    f.add("closed-reply", closed.id, "2026-10-28T12:00:00.000Z");
    f.add("foreign-reply", foreign.id, "2026-10-28T13:00:00.000Z");
    assert.deepEqual(f.tasks.listTasks({ tab: "active", projectId: f.project.id, order: "conversation" }).map(t => t.id), [active.id]);
    assert.deepEqual(f.tasks.listTasks({ tab: "closed", order: "conversation" }).map(t => t.id), [closed.id]);
  } finally { f.database.close(); }
});

test("task receipts require auth, canonicalize IDs and synchronize paired devices without reading on poll", async () => {
  const f = fixture();
  const task = f.create("Read me"), other = f.create("Other");
  f.add("reply", task.id, "2026-10-28T10:00:00.000Z");
  f.add("other-reply", other.id, "2026-10-28T10:00:00.000Z");
  const headers = ["desktop", "phone"].map(id => {
    f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES (?, ?, '', 'now', 'now')").run(id, id);
    return { authorization: `Bearer ${new AuthService(f.database, 365).createSession("test", "127.0.0.1", id).token}`, origin: f.config.publicBaseUrl };
  });
  const app = await buildApp(f.config, f.database);
  try {
    for (const [method, suffix] of [["GET", "unread"], ["POST", "read"]] as const) {
      assert.equal((await app.inject({ method, url: `/api/tasks/${task.id}/${suffix}` })).statusCode, 401);
    }
    const list = async (device: number) => {
      const response = await app.inject({ method: "GET", url: "/api/tasks?tab=active&order=conversation", headers: headers[device] });
      assert.equal(response.statusCode, 200);
      return response.json().tasks.find((t: { id: string }) => t.id === task.id).conversation;
    };
    assert.equal((await list(0)).unreadCount, 1);
    assert.equal((await app.inject({ method: "GET", url: `/api/tasks/${task.humanId}/workspace`, headers: headers[0] })).statusCode, 200);
    assert.equal((await list(1)).unreadCount, 1);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.humanId}/read`, headers: headers[0], payload: { messageIds: ["other-reply"] } })).json().readState.unreadCount, 1);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.humanId}/read`, headers: headers[0], payload: { messageIds: ["reply"] } })).json().readState.unreadCount, 0);
    assert.equal((await list(1)).unreadCount, 0);
    assert.equal((await app.inject({ method: "GET", url: `/api/tasks/${other.id}/unread`, headers: headers[1] })).json().readState.unreadCount, 1);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/read`, headers: headers[1], payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/tasks/missing/unread", headers: headers[1] })).statusCode, 404);
  } finally { await app.close(); }
});
