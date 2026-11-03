import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { documentFromPlainText } from "../src/domain/types.js";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AuthService } from "../src/server/auth.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { buildApp } from "../src/server/app.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "qahwa-cancellation-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Cancellation", prefix: "CAN", rootDirectory: root }, "user");
  const attachments = new AttachmentService(database, join(root, "uploads"));
  const agents = new AgentService(database, tasks, attachments);
  let slots = 0, reject = false, gate: Promise<void> | undefined;
  const requests: string[] = [];
  const client = Reflect.get(agents, "codex");
  t.mock.method(client, "initialize", async () => {});
  t.mock.method(client, "request", async (method: string) => {
    requests.push(method);
    if (method === "thread/start") return { thread: { id: `thread-${requests.length}` } };
    if (method === "turn/start") {
      await gate;
      if (reject) throw new Error("Temporary start failure");
      return { turn: { id: `turn-${requests.length}` } };
    }
    return {};
  });
  const capacity = agents.capacity();
  t.mock.method(agents, "capacity", () => ({ ...capacity, availableSlots: slots }));
  const f = {
    root, config, database, tasks, attachments, agents, requests,
    slots(value: number) { slots = value; }, reject(value: boolean) { reject = value; }, gate(value: Promise<void>) { gate = value; },
    task(status: "backlog" | "todo" = "todo") { return tasks.createTask({ projectId: project.id, title: "Keep this task's history", status }, "user"); },
    queue(id: string, by = "orchestrator") { database.db.prepare("INSERT INTO scheduler_queue (task_id, requested_by, reason, created_at) VALUES (?, ?, 'Test', ?)").run(id, by, new Date().toISOString()); },
    cancel(id: string) { return tasks.transition(id, { to: "closed", outcome: "cancelled", onlyIfUnstarted: true }, "user"); },
    async tick() { await Reflect.get(agents, "monitorPortfolio").call(agents); },
    async dispatch(ids: string[]) { return Reflect.get(agents, "applyOrchestratorActions").call(agents, [{ type: "dispatch", messageIds: ids }]); },
    close() { agents.close(); attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); },
  };
  t.after(() => f.close());
  return f;
}

for (const status of ["backlog", "todo"] as const) {
  test(`cancels queued ${status} work, preserves history/files, and prevents dispatch after restart`, async t => {
    const f = fixture(t), task = f.task(status), neighbor = f.task();
    const comment = f.tasks.addComment(task.id, { body: documentFromPlainText("Keep my note") }, "user");
    const now = new Date().toISOString();
    f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(now, now);
    const upload = f.attachments.initiate("task", task.id, "device", { filename: "context.txt", mediaType: "text/plain", size: 7 });
    f.attachments.appendChunk(upload.id, "device", 0, Buffer.from("context"));
    f.attachments.complete(upload.id, "device");
    const saved = (await f.agents.send("task", task.id, "Saved instructions", false, "user", [upload.id], "device")).messages[0]!;
    const neighborMessage = (await f.agents.send("task", neighbor.id, "Other task")).messages[0]!;
    f.queue(task.id); f.queue(neighbor.id);
    // Simulate a wait beyond normal file retention, protected while pending.
    f.database.db.prepare("UPDATE attachment_uploads SET expires_at = '2000-01-01' WHERE id = ?").run(upload.id);
    const closed = f.cancel(task.humanId);
    assert.equal(closed.status, "closed"); assert.equal(closed.outcome, "cancelled");
    assert.equal(closed.comments[0]?.id, comment.id);
    assert.equal(closed.smartMessage, "Cancelled");
    assert.equal(f.tasks.listTasks({ tab: "closed" }).some(x => x.id === task.id), true);
    assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(task.id), undefined);
    assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(neighbor.id) !== undefined, true);
    assert.equal(f.database.db.prepare("SELECT 1 FROM pending_messages WHERE message_id = ?").get(neighborMessage.id) !== undefined, true);
    assert.equal(f.agents.workspace("task", task.id).messages[0]?.body, "Saved instructions");
    assert.equal(f.agents.workspace("task", task.id).messages[0]?.pending, false);
    assert.equal(f.attachments.cleanupStale(), 0);
    assert.equal(readFileSync(f.attachments.resolveDownload("task", task.id, upload.id).path, "utf8"), "context");
    await f.dispatch([saved.id]);
    assert.equal(await Reflect.get(f.agents, "startSavedMessage").call(f.agents, saved.id), false);
    f.slots(1);
    await assert.rejects(f.agents.triggerTask(task.id), { code: "task_closed" });
    await assert.rejects(f.agents.send("task", task.id, "Late follow-up"), { code: "task_closed" });
    await assert.rejects(Reflect.get(f.agents, "beginImplementation").call(f.agents, task.id), { code: "task_closed" });
    assert.deepEqual(f.requests, []);
    // A fresh service sees the same tombstone, with no pending work to replay.
    f.agents.close();
    const reloaded = new AppDatabase(f.config);
    const restarted = new AgentService(reloaded, new TaskService(reloaded), f.attachments);
    try {
      assert.equal(restarted.workspace("task", task.id).messages[0]?.pending, false);
      assert.equal(new TaskService(reloaded).getTask(task.id).outcome, "cancelled");
    } finally { restarted.close(); reloaded.close(); }
  });
}

test("startup reserves the task before RPC acknowledgement and stale cancellation conflicts", async t => {
  const f = fixture(t), task = f.task();
  f.slots(1);
  let release!: () => void;
  f.gate(new Promise<void>(resolve => { release = resolve; }));
  const starting = f.agents.send("task", task.id, "Start this saved message");
  assert.equal(f.agents.workspace("task", task.id).session.runState, "running");
  const otherConnection = new AppDatabase(f.config);
  try {
    assert.throws(() => new TaskService(otherConnection).transition(task.id, { to: "closed", outcome: "cancelled", onlyIfUnstarted: true }, "user"), { code: "task_running", statusCode: 409 });
    assert.equal(f.tasks.getTask(task.id).status, "todo");
  } finally { otherConnection.close(); release(); }
  await starting;
  assert.equal(f.requests.filter(x => x === "turn/start").length, 1);
  f.database.db.prepare("UPDATE agent_sessions SET run_state = 'idle', active_turn_id = NULL WHERE owner_id = ?").run(task.id);
  assert.throws(() => f.cancel(task.id), { code: "task_started" });
});

test("direct task startup wins against a cancellation submitted from stale Todo controls", async t => {
  const f = fixture(t), task = f.task(); f.slots(1);
  const starting = f.agents.triggerTask(task.id);
  assert.throws(() => f.cancel(task.id), { code: "task_started", statusCode: 409 });
  await starting;
  assert.equal(f.tasks.getTask(task.id).status, "in_progress");
  assert.equal(f.requests.filter(x => x === "turn/start").length, 1);
});

test("failed startup can be cancelled and never retried", async t => {
  const f = fixture(t), task = f.task(); f.slots(1); f.reject(true);
  const failed = await f.agents.send("task", task.id, "Saved for retry");
  assert.equal(failed.session.runState, "failed");
  assert.equal(failed.messages[0]?.pending, true);
  f.cancel(task.id); f.reject(false);
  await f.dispatch([failed.messages[0]!.id]); await f.tick();
  assert.equal(f.requests.filter(x => x === "turn/start").length, 1);
  assert.equal(f.tasks.getTask(task.id).outcome, "cancelled");
});

test("cancellation rollback keeps task, queues and history intact on storage failure", async t => {
  const f = fixture(t), task = f.task(); f.queue(task.id);
  const saved = (await f.agents.send("task", task.id, "Keep this pending message")).messages[0]!;
  f.database.db.exec("CREATE TRIGGER fail_cancel BEFORE DELETE ON scheduler_queue BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END");
  assert.throws(() => f.cancel(task.id), /Simulated storage failure/);
  assert.equal(f.tasks.getTask(task.id).status, "todo");
  assert.equal(f.agents.workspace("task", task.id).messages[0]?.pending, true);
  assert.ok(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(task.id));
  assert.ok(f.database.db.prepare("SELECT 1 FROM pending_messages WHERE message_id = ?").get(saved.id));
});

test("closure guards and existing started-task cancellation are preserved", async t => {
  const f = fixture(t), backlog = f.task("backlog"), started = f.task();
  assert.throws(() => f.tasks.transition(backlog.id, { to: "closed", outcome: "completed" }, "codex"), { code: "explicit_instruction_required" });
  assert.throws(() => f.tasks.transition(backlog.id, { to: "closed", outcome: "cancelled" }, "codex"), { code: "explicit_instruction_required" });
  f.tasks.transition(started.id, { to: "in_progress" }, "codex");
  assert.throws(() => f.cancel(started.id), { code: "task_started" });
  assert.equal(f.tasks.transition(started.id, { to: "closed", outcome: "cancelled" }, "user").outcome, "cancelled");
  f.tasks.transition(backlog.id, { to: "closed", outcome: "cancelled", explicitUserInstruction: "Cancel this task" }, "codex");
  assert.throws(() => f.cancel(backlog.id), { statusCode: 409 });
});

test("HTTP cancellation enforces authentication, stale-start conflict, and closed-task protections", async t => {
  const f = fixture(t); f.agents.close();
  const now = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(now, now);
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  // The application owns its own isolated services. Prevent title generation/model calls.
  const app = await buildApp(f.config, f.database, { generateTitle: async () => "Cancellation" });
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const task = f.task("backlog"), started = f.task();
  const payload = { to: "closed", outcome: "cancelled", onlyIfUnstarted: true };
  const url = `/api/tasks/${task.humanId}/transition`;
  try {
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://other.invalid" }, payload })).statusCode, 403);
    const response = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().task.outcome, "cancelled");
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 409);
    f.tasks.transition(started.id, { to: "in_progress" }, "codex");
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${started.id}/transition`, headers, payload })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/messages`, headers, payload: { message: "Late work" } })).statusCode, 409);
  } finally { await app.close(); }
});

test("a cancellation between message preparation and saving cannot recreate pending work", async t => {
  const f = fixture(t), task = f.task();
  t.mock.method(f.attachments, "retainForPendingMessage", () => { f.cancel(task.id); });
  await assert.rejects(f.agents.send("task", task.id, "Stale submission"), { code: "task_closed" });
  assert.equal(f.agents.workspace("task", task.id).messages.length, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM pending_messages").get()!.n, 0);
  assert.deepEqual(f.requests, []);
});

test("a stale scheduler snapshot and later authorized start cannot revive a cancelled task", async t => {
  const f = fixture(t), first = f.task(), cancelled = f.task();
  // Different worktrees avoid hiding the closed-task guard behind project locking.
  mkdirSync(join(f.root, "other"));
  const otherProject = f.tasks.createProject({ name: "Other", prefix: "OTH", rootDirectory: join(f.root, "other") }, "user");
  f.database.db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(otherProject.id, cancelled.id);
  f.queue(first.id); f.queue(cancelled.id); f.slots(1);
  let release!: () => void;
  f.gate(new Promise<void>(resolve => { release = resolve; }));
  const draining = Reflect.get(f.agents, "drainSchedulerQueue").call(f.agents);
  f.cancel(cancelled.id);
  release(); await draining;
  assert.equal(f.requests.filter(x => x === "turn/start").length, 1);
  const outcomes = await Reflect.get(f.agents, "applyOrchestratorActions").call(f.agents,
    [{ type: "start", taskId: cancelled.id, authorization: "Start the task" }], "Start the task");
  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].message, /Closed tasks cannot be started/);
  assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(cancelled.id), undefined);
  assert.equal(f.agents.workspace("task", cancelled.id).messages.length, 0);
});

test("waiting startup and malformed cancellation guards cannot close pending tasks", async t => {
  const f = fixture(t), task = f.task("backlog");
  f.agents.workspace("task", task.id);
  f.database.db.prepare("UPDATE agent_sessions SET run_state = 'waiting' WHERE owner_id = ?").run(task.id);
  assert.throws(() => f.cancel(task.id), { code: "task_running", statusCode: 409 });
  assert.throws(() => f.tasks.transition(task.id, { to: "closed", outcome: "cancelled", onlyIfUnstarted: "true" as any }, "user"), { code: "invalid_cancellation" });
  assert.equal(f.tasks.getTask(task.id).status, "backlog");
});
