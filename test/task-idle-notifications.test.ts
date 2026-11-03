import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { TaskIdleNotifier } from "../src/server/task-idle-notifier.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import type { AppNotification } from "../src/server/app-push-service.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-idle-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.example.test", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Idle tests", prefix: "IDL", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Notify on idle", status: "todo" }, "user");
  const other = tasks.createTask({ projectId: project.id, title: "Another task" }, "user");
  const calls: AppNotification[] = [];
  const notifier = (send = async () => 1) => new TaskIdleNotifier(database, {
    send: async notification => { calls.push(notification); return send(); },
  });
  return { root, config, database, tasks, task, other, calls, notifier,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("existing and new tasks default off; preferences persist independently across database reopen", () => {
  const f = fixture();
  try {
    assert.equal(f.task.idleNotificationsEnabled, false);
    // Recreate the previous schema, then let the normal startup migration run.
    f.database.db.exec("ALTER TABLE tasks DROP COLUMN idle_notifications_enabled");
    f.database.close();
    let reopened = new AppDatabase(f.config);
    let tasks = new TaskService(reopened);
    assert.equal(tasks.getTask(f.task.id).idleNotificationsEnabled, false);
    assert.equal(tasks.getTask(f.other.id).idleNotificationsEnabled, false);
    const original = tasks.getTask(f.task.id);
    tasks.setIdleNotifications(f.task.humanId, true);
    assert.equal(tasks.getTask(f.task.id).version, original.version, "Preference does not conflict with content editing");
    assert.throws(() => tasks.setIdleNotifications(f.task.id, "true"), /enabled or disabled/);
    reopened.close();
    reopened = new AppDatabase(f.config); tasks = new TaskService(reopened);
    assert.equal(tasks.getTask(f.task.id).idleNotificationsEnabled, true);
    assert.equal(tasks.getTask(f.other.id).idleNotificationsEnabled, false);
    assert.equal(tasks.createTask({ projectId: f.task.projectId, title: "New after migration" }, "user").idleNotificationsEnabled, false);
    tasks.setIdleNotifications(f.task.id, false);
    assert.equal(tasks.getTask(f.task.id).idleNotificationsEnabled, false);
    reopened.close();
  } finally { if (f.database.db.open) f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("paired-only preference endpoint validates booleans and saves only the addressed task", async () => {
  const f = fixture();
  const app = await buildApp(f.config, f.database);
  const stamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Fixture','',?,?)").run(stamp, stamp);
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const url = `/api/tasks/${f.task.humanId}/idle-notifications`;
  try {
    assert.equal((await app.inject({ method: "PUT", url, payload: { enabled: true } })).statusCode, 401);
    for (const enabled of ["true", 1, null, {}, []]) {
      assert.equal((await app.inject({ method: "PUT", url, headers, payload: { enabled } })).statusCode, 400);
    }
    for (const enabled of [true, false, true]) {
      const saved = await app.inject({ method: "PUT", url, headers, payload: { enabled } });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().task.idleNotificationsEnabled, enabled);
      const loaded = await app.inject({ method: "GET", url: `/api/tasks/${f.task.id}`, headers });
      assert.equal(loaded.json().task.idleNotificationsEnabled, enabled);
      assert.equal(f.tasks.getTask(f.other.id).idleNotificationsEnabled, false);
    }
    assert.equal((await app.inject({ method: "PUT", url: "/api/tasks/missing/idle-notifications", headers, payload: { enabled: true } })).statusCode, 404);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("opt-in app notifications suppress concurrent/recreated duplicates and respect opt-out", async () => {
  const f = fixture();
  try {
    await f.notifier().completed(f.task.id, "thread", "off");
    assert.equal(f.calls.length, 0);
    f.tasks.setIdleNotifications(f.task.id, true);
    await Promise.all([f.notifier().completed(f.task.id, "thread", "turn-1"), f.notifier().completed(f.task.id, "thread", "turn-1")]);
    await f.notifier().completed(f.task.id, "thread", "turn-1");
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { title: "Task is idle", body: `${f.task.humanId} · Notify on idle\nIdle tests`,
      url: `/tasks/${f.task.humanId}`, tag: `task-idle:${f.task.id}:thread:turn-1` });
    await f.notifier().completed(f.task.id, "thread", "turn-2");
    assert.equal(f.calls.length, 2);
    f.tasks.setIdleNotifications(f.task.id, false);
    await f.notifier().completed(f.task.id, "thread", "turn-3");
    assert.equal(f.calls.length, 2);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM task_idle_notifications WHERE status = 'sent'").get().count, 2);
  } finally { f.close(); }
});

test("unavailable devices and push failures are isolated and never retried by duplicate events", async () => {
  const f = fixture();
  try {
    f.tasks.setIdleNotifications(f.task.id, true);
    for (const [turn, send] of [
      ["network", async () => { throw new Error("Network unavailable"); }],
      ["no-devices", async () => 0],
    ] as const) {
      const notifier = f.notifier(send);
      await assert.doesNotReject(notifier.completed(f.task.id, "thread", turn));
      await notifier.completed(f.task.id, "thread", turn);
    }
    assert.equal(f.calls.length, 2);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM task_idle_notifications WHERE status = 'failed'").get().count, 2);
    assert.equal(f.tasks.getTask(f.task.id).status, "todo");
  } finally { f.close(); }
});

test("actual completion handler notifies only a successful active task turn; delivery does not block queue progress", async () => {
  const f = fixture();
  const deliveries: string[] = [];
  let release!: () => void;
  const pendingDelivery = new Promise<void>(resolve => { release = resolve; });
  const agents = new AgentService(f.database, f.tasks, new AttachmentService(f.database, join(f.root, "attachments")), {
    async completed(taskId, threadId, turnId) { deliveries.push(`${taskId}:${threadId}:${turnId}`); await pendingDelivery; throw new Error("Delivery failed"); },
  });
  let queueResumes = 0;
  Reflect.set(agents, "resumeQueues", async () => { queueResumes++; });
  Reflect.set(agents, "restartAfterCompletedSelfDeploy", () => false);
  const handle = (params: object) => Reflect.get(agents, "handleCodexMessage").call(agents, { method: "turn/completed", params });
  const session = (state: string, turnId: string, type = "task", owner = f.task.id) => {
    agents.workspace(type as "task" | "orchestrator", owner);
    f.database.db.prepare("UPDATE agent_sessions SET thread_id = ?, active_turn_id = ?, run_state = ? WHERE owner_type = ? AND owner_id = ?")
      .run(`${type}-thread`, turnId, state, type, owner);
  };
  const complete = (id: string, status: string, threadId = "task-thread") => handle({ threadId, turn: { id, status } });
  try {
    for (const [state, status] of [["waiting", "completed"], ["interrupted", "completed"], ["running", "failed"], ["running", "interrupted"]]) {
      session(state!, `${state}-${status}`); complete(`${state}-${status}`, status!);
    }
    session("running", "orchestrator-turn", "orchestrator", "main");
    complete("orchestrator-turn", "completed", "orchestrator-thread");
    session("running", "current-turn"); complete("stale-turn", "completed");
    assert.equal(agents.workspace("task", f.task.id).session.activeTurnId, "current-turn");
    session("running", "missing-status"); handle({ threadId: "task-thread", turn: { id: "missing-status" } });
    session("running", "pending-input");
    f.database.db.prepare(`INSERT INTO pending_requests(id,owner_type,owner_id,request_type,payload_json,created_at)
      VALUES ('input-request','task',?,'user_input','{}',?)`).run(f.task.id, new Date().toISOString());
    complete("pending-input", "completed");
    f.database.db.prepare("UPDATE pending_requests SET status='answered' WHERE id='input-request'").run();
    assert.deepEqual(deliveries, []);
    session("running", "success"); complete("success", "completed");
    assert.deepEqual(deliveries, [`${f.task.id}:task-thread:success`]);
    assert.equal(agents.workspace("task", f.task.id).session.runState, "idle");
    const resumed = queueResumes;
    assert.ok(resumed > 0, "Queue resumed before notification delivery resolved");
    complete("success", "completed");
    assert.equal(deliveries.length, 1);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(agents.workspace("task", f.task.id).session.runState, "idle");
  } finally { release(); agents.close(); f.close(); }
});
