import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "qahwa-task-actions-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config), tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Task actions", prefix: "ACT", rootDirectory: root }, "user");
  const attachments = new AttachmentService(database, join(root, "uploads")), agents = new AgentService(database, tasks, attachments);
  t.mock.method(agents, "capacity", () => ({ activeTurns: 0, availableSlots: 0, recommendedParallelism: 1 }));
  const create = (status: "backlog" | "todo" | "in_progress" | "in_review") => {
    const task = tasks.createTask({ projectId: project.id, title: "Keep history", status: status === "backlog" ? status : "todo" }, "user");
    if (status === "in_progress" || status === "in_review") tasks.transition(task.id, { to: "in_progress" }, "codex");
    if (status === "in_review") tasks.submitForReview(task.id, { summary: "Reviewed" }, "codex");
    agents.workspace("task", task.id);
    return task;
  };
  t.after(() => { agents.close(); attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return { database, tasks, agents, attachments, config, create };
}

for (const status of ["backlog", "todo", "in_progress", "in_review"] as const) {
  for (const outcome of ["completed", "cancelled"] as const) {
    test(`${outcome} from ${status} requires pause, including stale startup reservations`, t => {
      const f = fixture(t), task = f.create(status);
      for (const state of ["running", "waiting", "starting", "active_turn"] as const) {
        f.database.db.prepare("UPDATE agent_sessions SET run_state = ?, starting_message_id = ?, active_turn_id = ? WHERE owner_id = ?")
          .run(state === "running" || state === "waiting" ? state : "idle", state === "starting" ? "reserved" : null, state === "active_turn" ? "turn" : null, task.id);
        assert.throws(() => f.tasks.transition(task.id, { to: "closed", outcome }, "user"), { code: "task_running", statusCode: 409 });
        assert.equal(f.tasks.getTask(task.id).status, status);
      }
      f.database.db.prepare("UPDATE agent_sessions SET run_state = 'idle', starting_message_id = NULL, active_turn_id = NULL WHERE owner_id = ?").run(task.id);
      assert.throws(() => f.tasks.transition(task.id, { to: "closed", outcome }, "codex"), { code: "explicit_instruction_required" });
      const closed = f.tasks.transition(task.id, { to: "closed", outcome }, "user");
      assert.equal(closed.outcome, outcome);
      assert.throws(() => f.tasks.transition(task.id, { to: "closed", outcome }, "user"), { code: "invalid_transition" });
    });
  }
}

test("completing queued work preserves messages and files and prevents later dispatch", async t => {
  const f = fixture(t), task = f.create("todo");
  const stamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(stamp, stamp);
  const file = f.attachments.initiate("task", task.id, "device", { filename: "history.txt", mediaType: "text/plain", size: 7 });
  f.attachments.appendChunk(file.id, "device", 0, Buffer.from("history")); f.attachments.complete(file.id, "device");
  const saved = (await f.agents.send("task", task.id, "Saved history", false, "user", [file.id], "device")).messages[0]!;
  f.database.db.prepare("INSERT INTO scheduler_queue (task_id, requested_by, reason, created_at) VALUES (?, 'user', 'Test', ?)").run(task.id, stamp);
  f.database.db.prepare("UPDATE attachment_uploads SET expires_at = '2000-01-01' WHERE id = ?").run(file.id);
  const closed = f.tasks.transition(task.id, { to: "closed", outcome: "completed" }, "user");
  assert.equal(closed.smartMessage, "Completed");
  assert.equal(f.database.db.prepare("SELECT 1 FROM pending_messages WHERE message_id = ?").get(saved.id), undefined);
  assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(task.id), undefined);
  assert.equal(f.agents.workspace("task", task.id).messages[0]?.body, "Saved history");
  assert.equal(f.attachments.cleanupStale(), 0);
  assert.ok(f.attachments.resolveDownload("task", task.id, file.id));
  t.mock.method(f.agents, "capacity", () => ({ activeTurns: 0, availableSlots: 1, recommendedParallelism: 1 }));
  await assert.rejects(f.agents.triggerTask(task.id), { code: "task_closed" });
});

test("a paused turn in Todo can be cancelled without bypassing the stale unstarted guard", t => {
  const f = fixture(t), task = f.create("todo");
  f.database.db.prepare("INSERT INTO session_events (owner_type, owner_id, event_type, payload_json, created_at) VALUES ('task', ?, 'turn.started', '{}', ?)").run(task.id, new Date().toISOString());
  assert.throws(() => f.tasks.transition(task.id, { to: "closed", outcome: "cancelled", onlyIfUnstarted: true }, "user"), { code: "task_started" });
  assert.equal(f.tasks.transition(task.id, { to: "closed", outcome: "cancelled" }, "user").outcome, "cancelled");
});

test("authenticated HTTP completion accepts unreviewed tasks and rejects active runs", async t => {
  const f = fixture(t); f.agents.close();
  const stamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(stamp, stamp);
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const app = await buildApp(f.config, f.database, { generateTitle: async () => "Actions" });
  try {
    const task = f.create("backlog"), url = `/api/tasks/${task.id}/transition`, payload = { to: "closed", outcome: "completed" };
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
    const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
    f.database.db.prepare("UPDATE agent_sessions SET run_state = 'running' WHERE owner_id = ?").run(task.id);
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 409);
    f.database.db.prepare("UPDATE agent_sessions SET run_state = 'idle' WHERE owner_id = ?").run(task.id);
    const result = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().task.outcome, "completed");
  } finally { await app.close(); }
});
