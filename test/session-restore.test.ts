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
import { workspacePoll } from "../src/server/workspace-poll.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "qahwa-restore-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config), tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Restore", prefix: "RST", rootDirectory: root }, "user");
  const attachments = new AttachmentService(database), agents = new AgentService(database, tasks, attachments);
  const requests: Array<{ method: string; params: any }> = [];
  const codex = Reflect.get(agents, "codex");
  t.mock.method(codex, "initialize", async () => {});
  t.mock.method(codex, "request", async (method: string, params: any) => {
    requests.push({ method, params });
    return method === "thread/start" ? { thread: { id: "new-thread" } } : method === "turn/start" ? { turn: { id: "new-turn" } } : {};
  });
  t.mock.method(agents, "capacity", () => ({ activeTurns: 0, availableSlots: 0 } as any));
  const task = (outcome: "completed" | "cancelled" = "cancelled") => {
    const value = tasks.createTask({ projectId: project.id, title: "Keep my saved work", status: "todo" }, "user");
    agents.workspace("task", value.id);
    if (outcome === "completed") {
      tasks.transition(value.id, { to: "in_progress" }, "codex");
      tasks.transition(value.id, { to: "in_review" }, "codex");
    }
    return tasks.transition(value.id, { to: "closed", outcome }, "user");
  };
  t.after(() => { agents.close(); attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, database, tasks, project, attachments, agents, requests, task };
}

for (const outcome of ["completed", "cancelled"] as const) {
  test(`restores ${outcome} Codex session with all saved content and archived association`, async t => {
    const f = fixture(t), task = f.task(outcome), neighbor = f.task();
    f.tasks.addRelatedTask(task.id, neighbor.id, "user");
    f.tasks.addOutput(task.id, { summary: "Saved result", validation: ["Passed"], limitations: [] }, "codex");
    f.tasks.setPinned(task.id, true);
    f.tasks.setIdleNotifications(task.id, true);
    const timestamp = new Date().toISOString();
    f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(timestamp, timestamp);
    const upload = f.attachments.initiate("task", task.id, "device", { filename: "context.txt", mediaType: "text/plain", size: 7 });
    f.attachments.appendChunk(upload.id, "device", 0, Buffer.from("context"));
    f.attachments.complete(upload.id, "device");
    f.database.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at) VALUES ('saved','task',?,'user','Saved history',?,?)")
      .run(task.id, JSON.stringify({ attachments: [{ id: upload.id, filename: "context.txt", mediaType: "text/plain", size: 7 }], custom: "keep" }), timestamp);
    f.attachments.attachToMessage([upload.id], "saved");
    f.database.db.prepare(`INSERT INTO design_pages(id,task_id,name,document_json,revision,created_at,updated_at)
      VALUES ('page',?,'Saved canvas',?,3,?,?)`).run(task.id, JSON.stringify({ format: "web", artboard: { width: 390, height: 844, background: "#fff", name: "Canvas" }, html: '<h1 data-qahwa-id="heading">Keep me</h1>', css: "" }), timestamp, timestamp);
    f.database.db.prepare("INSERT INTO design_page_selection(task_id,page_id) VALUES (?,'page')").run(task.id);
    const comment = f.tasks.addComment(task.id, { body: documentFromPlainText("Canvas feedback"), metadata: { canvas: { pageId: "page", elementId: "heading" } } }, "user");
    f.database.db.prepare("UPDATE agent_sessions SET thread_id = 'saved-thread', surface = 'design', intake_state = 'ready', run_state = 'failed', last_error = 'Old failure' WHERE owner_id = ?").run(task.id);
    f.tasks.archiveProject(f.project.id, true, "user");
    const before = f.tasks.getTask(task.id), workspace = f.agents.workspace("task", task.id);
    const restored = f.tasks.restoreCodex(task.humanId, before.version);
    assert.equal(restored.id, task.id); assert.equal(restored.humanId, task.humanId);
    assert.equal(restored.projectId, task.projectId); assert.equal(restored.status, "backlog"); assert.equal(restored.outcome, null);
    assert.equal(restored.version, before.version + 1); assert.equal(restored.smartMessage, "Restored to Backlog");
    for (const key of ["description", "title", "createdAt", "pinnedAt", "idleNotificationsEnabled", "outputs", "comments", "relatedTasks"] as const) assert.deepEqual(restored[key], before[key], key);
    assert.equal(restored.comments[0]!.id, comment.id);
    const after = f.agents.workspace("task", task.id);
    assert.deepEqual(after.messages, workspace.messages); assert.deepEqual(after.designPages, workspace.designPages);
    assert.equal(after.selectedDesignPageId, "page"); assert.equal(after.session.threadId, "saved-thread");
    assert.equal(after.session.surface, "design"); assert.equal(after.session.intakeState, "ready");
    assert.equal(after.session.runState, "idle"); assert.equal(after.session.lastError, null);
    assert.ok(f.tasks.listProjects(true).find(p => p.id === task.projectId)?.archivedAt);
    assert.ok(f.tasks.listTasks({ tab: "backlog" }).some(t => t.id === task.id));
    assert.equal(readFileSync(f.attachments.resolveDownload("task", task.id, upload.id).path, "utf8"), "context");
    assert.equal(f.tasks.getTask(neighbor.id).status, "closed"); assert.deepEqual(f.requests, []);
    const reloaded = new AppDatabase(f.config);
    try {
      const persisted = new TaskService(reloaded).getTask(task.id);
      assert.equal(persisted.status, "backlog"); assert.equal(persisted.outcome, null); assert.deepEqual(persisted.outputs, before.outputs);
      assert.deepEqual(reloaded.db.pragma("foreign_key_check"), []);
    } finally { reloaded.close(); }
  });
}

test("restoration removes stale delivery, schedules and approvals without model calls; only a later request resumes the saved thread", async t => {
  const f = fixture(t), task = f.task();
  const timestamp = new Date().toISOString();
  f.database.db.prepare("UPDATE agent_sessions SET thread_id='saved-thread',intake_state='ready',run_state='idle' WHERE owner_id=?").run(task.id);
  f.database.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,created_at) VALUES ('stale','task',?,'user','Old instruction',?)").run(task.id, timestamp);
  f.database.db.prepare("INSERT INTO pending_messages(message_id,dispatch_order) VALUES ('stale',1)").run();
  f.database.db.prepare("INSERT INTO scheduler_queue(task_id,requested_by,reason,created_at) VALUES (?,'intake','Old authorization',?)").run(task.id, timestamp);
  f.database.db.prepare("INSERT INTO task_schedules(task_id,version,local_time,timezone,run_at,policy,state,updated_at) VALUES (?,1,'2026-01-01T12:00','UTC','2026-01-01T12:00:00Z','when_available','reserved',?)").run(task.id, timestamp);
  f.database.db.prepare("INSERT INTO pending_requests(id,owner_type,owner_id,rpc_request_id,request_type,payload_json,created_at) VALUES ('approval','task',?,'12','permissions','{}',?)").run(task.id, timestamp);
  f.tasks.restoreCodex(task.id, task.version);
  assert.equal(f.database.db.prepare("SELECT 1 FROM pending_messages WHERE message_id='stale'").get(), undefined);
  assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id=?").get(task.id), undefined);
  const workspace = f.agents.workspace("task", task.id);
  assert.equal(workspace.schedule?.state, "cancelled"); assert.equal(workspace.pendingRequests.length, 0);
  assert.equal(workspace.messages[0]!.body, "Old instruction"); assert.equal(workspace.messages[0]!.pending, false);
  await assert.rejects(f.agents.resolveRequest("approval", { approved: true }), { code: "request_not_found" });
  t.mock.method(f.agents, "capacity", () => ({ activeTurns: 0, availableSlots: 1 } as any));
  await Reflect.get(f.agents, "drainSchedulerQueue").call(f.agents);
  assert.equal(await Reflect.get(f.agents, "startSavedMessage").call(f.agents, "stale"), false);
  assert.deepEqual(f.requests, []);
  await f.agents.send("task", task.id, "Continue with this explicit request");
  assert.equal(f.requests[0]!.method, "thread/resume"); assert.equal(f.requests[0]!.params.threadId, "saved-thread");
  assert.equal(f.requests.filter(x => x.method === "turn/start").length, 1);
  assert.equal(f.agents.workspace("task", task.id).session.intakeState, "ready");
  assert.equal(f.tasks.getTask(task.id).status, "in_progress");
});

test("stale restores cannot reopen a later closure and live/startup sessions conflict", t => {
  const f = fixture(t), task = f.task();
  for (const expected of [undefined, 0, "1", -1]) assert.throws(() => f.tasks.restoreCodex(task.id, expected), { code: "invalid_version" });
  for (const state of ["running", "waiting"]) {
    f.database.db.prepare("UPDATE agent_sessions SET run_state=? WHERE owner_id=?").run(state, task.id);
    assert.throws(() => f.tasks.restoreCodex(task.id, task.version), { code: "task_running" });
  }
  f.database.db.prepare("UPDATE agent_sessions SET run_state='idle',starting_message_id='starting' WHERE owner_id=?").run(task.id);
  assert.throws(() => f.tasks.restoreCodex(task.id, task.version), { code: "task_running" });
  f.database.db.prepare("UPDATE agent_sessions SET starting_message_id=NULL WHERE owner_id=?").run(task.id);
  f.database.db.prepare("INSERT INTO session_events(owner_type,owner_id,event_type,created_at) VALUES ('task',?,'turn.started',?)").run(task.id, new Date().toISOString());
  f.tasks.restoreCodex(task.id, task.version);
  f.tasks.transition(task.id, { to: "closed", outcome: "cancelled", onlyIfUnstarted: true }, "user");
  assert.throws(() => f.tasks.restoreCodex(task.id, task.version), { code: "restore_conflict" });
  assert.equal(f.tasks.getTask(task.id).status, "closed");
  f.tasks.restoreCodex(task.id, task.version + 1);
});

test("storage failure rolls back the entire restore", t => {
  const f = fixture(t), task = f.task();
  const before = f.agents.workspace("task", task.id);
  f.database.db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON activity WHEN NEW.event_type='task.restored' BEGIN SELECT RAISE(ABORT,'Fixture failure'); END");
  assert.throws(() => f.tasks.restoreCodex(task.id, task.version), /Fixture failure/);
  assert.equal(f.tasks.getTask(task.id).status, "closed"); assert.equal(f.tasks.getTask(task.id).version, task.version);
  assert.deepEqual(f.agents.workspace("task", task.id), before);
});

test("late events from the old turn cannot revive approvals or change the restored session", t => {
  const f = fixture(t), task = f.task();
  f.database.db.prepare("UPDATE agent_sessions SET thread_id='saved-thread',run_state='idle' WHERE owner_id=?").run(task.id);
  f.tasks.restoreCodex(task.id, task.version);
  const before = f.agents.workspace("task", task.id);
  const handle = (message: any) => Reflect.get(f.agents, "handleCodexMessage").call(f.agents, message);
  handle({ id: 42, method: "item/permissions/requestApproval", params: { threadId: "saved-thread", turnId: "old-turn", permissions: { network: true } } });
  handle({ method: "item/completed", params: { threadId: "saved-thread", turnId: "old-turn", item: { id: "late", type: "agentMessage", text: "Late old response" } } });
  handle({ method: "turn/completed", params: { threadId: "saved-thread", turn: { id: "old-turn", status: "failed" } } });
  assert.deepEqual(f.agents.workspace("task", task.id), before);
  assert.equal(f.tasks.getTask(task.id).smartMessage, "Restored to Backlog");
});

test("restoring an intake thread preserves its read-only intake on a later explicit request", async t => {
  const f = fixture(t), task = f.task();
  f.database.db.prepare("UPDATE agent_sessions SET thread_id='intake-thread',run_state='idle',intake_state='pending' WHERE owner_id=?").run(task.id);
  f.tasks.restoreCodex(task.id, task.version);
  t.mock.method(f.agents, "capacity", () => ({ activeTurns: 0, availableSlots: 1 } as any));
  await f.agents.send("task", task.id, "Continue clarifying this task");
  assert.equal(f.requests[0]!.method, "thread/resume");
  assert.equal(f.requests[0]!.params.threadId, "intake-thread");
  assert.equal(f.requests[0]!.params.sandbox, "read-only");
  assert.match(f.requests[0]!.params.developerInstructions, /mandatory read-only intake/);
});

test("a scheduler snapshot captured before restore cannot recreate its removed start request", async t => {
  const f = fixture(t), task = f.task();
  const otherRoot = join(f.root, "other"); mkdirSync(otherRoot);
  const project = f.tasks.createProject({ name: "Other", prefix: "OTH", rootDirectory: otherRoot }, "user");
  const first = f.tasks.createTask({ projectId: project.id, title: "First queued start", status: "todo" }, "user");
  f.database.db.prepare("INSERT INTO scheduler_queue(task_id,requested_by,reason,created_at) VALUES (?,'orchestrator','Authorized','2026-01-01')").run(first.id);
  f.database.db.prepare("INSERT INTO scheduler_queue(task_id,requested_by,reason,created_at) VALUES (?,'orchestrator','Old authorization','2026-01-02')").run(task.id);
  t.mock.method(f.agents, "capacity", () => ({ activeTurns: 0, availableSlots: 1 } as any));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const starting = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(Reflect.get(f.agents, "codex"), "request", async (method: string, params: any) => {
    f.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${f.requests.length}` } };
    if (method === "turn/start") { started(); await gate; return { turn: { id: `turn-${f.requests.length}` } }; }
    return {};
  });
  const draining = Reflect.get(f.agents, "drainSchedulerQueue").call(f.agents);
  await starting;
  f.tasks.restoreCodex(task.id, task.version);
  release(); await draining;
  assert.equal(f.tasks.getTask(task.id).status, "backlog");
  assert.equal(f.requests.filter(x => x.method === "turn/start").length, 1);
  assert.equal(f.agents.workspace("task", task.id).messages.length, 0);
});

test("an intake handoff awaiting archive cannot start work after a close and restore", async t => {
  const f = fixture(t), task = f.task();
  f.database.db.prepare("UPDATE agent_sessions SET thread_id='saved-intake',intake_state='ready',run_state='idle' WHERE owner_id=?").run(task.id);
  const restored = f.tasks.restoreCodex(task.id, task.version);
  t.mock.method(f.agents, "capacity", () => ({ activeTurns: 0, availableSlots: 1 } as any));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const archiving = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(Reflect.get(f.agents, "codex"), "request", async (method: string, params: any) => {
    f.requests.push({ method, params });
    if (method === "thread/archive") { started(); await gate; }
    return {};
  });
  const handoff = Reflect.get(f.agents, "beginImplementation").call(f.agents, task.id);
  await archiving;
  assert.throws(() => f.tasks.transition(task.id, { to: "closed", outcome: "cancelled" }, "user"), { code: "task_running" });
  // The handoff now reserves before archiving, so explicit interruption is required.
  f.database.db.prepare("UPDATE agent_sessions SET run_state='interrupted',starting_message_id=NULL WHERE owner_id=?").run(task.id);
  f.tasks.transition(task.id, { to: "closed", outcome: "cancelled" }, "user");
  f.tasks.restoreCodex(task.id, f.tasks.getTask(task.id).version);
  release(); await handoff;
  assert.equal(f.tasks.getTask(task.id).status, "backlog");
  assert.equal(f.agents.workspace("task", task.id).session.threadId, "saved-intake");
  assert.equal(f.agents.workspace("task", task.id).messages.length, 1);
  assert.equal(f.requests.filter(x => x.method === "turn/start").length, 0);
});

test("concurrent device restores, lost acknowledgement and cross-device refresh use persisted state", async t => {
  const f = fixture(t), task = f.task("completed");
  const app = await buildApp(f.config, f.database, { generateTitle: async () => "Fixture" });
  const auth = new AuthService(f.database, f.config.sessionDays);
  const timestamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(timestamp, timestamp);
  const headers = { authorization: `Bearer ${auth.createSession(null, null, "device").token}`, origin: f.config.publicBaseUrl };
  const url = `/api/tasks/${task.humanId}/restore`, payload = { expectedVersion: task.version };
  const oldPoll = workspacePoll(f.agents.workspace("task", task.id), {});
  try {
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://other.invalid" }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 400);
    const results = await Promise.all([app.inject({ method: "POST", url, headers, payload }), app.inject({ method: "POST", url, headers, payload })]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal(f.tasks.activityForTask(task.id).filter((a: any) => a.eventType === "task.restored").length, 1);
    // Treat the successful POST as lost. A fresh device/connection still sees it.
    const other = new AppDatabase(f.config);
    try {
      assert.equal(new TaskService(other).getTask(task.id).status, "backlog");
      assert.throws(() => new TaskService(other).restoreCodex(task.id, task.version), { code: "restore_conflict" });
    } finally { other.close(); }
    const refreshed = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers });
    assert.equal(refreshed.json().task.status, "backlog"); assert.equal(refreshed.json().task.outcome, null);
    assert.notEqual(workspacePoll(f.agents.workspace("task", task.id), oldPoll).revision, oldPoll.revision);
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 409);
    f.database.db.prepare("UPDATE tasks SET session_kind='terminal',status='closed',outcome='cancelled' WHERE id=?").run(task.id);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { expectedVersion: task.version + 1 } })).json().code, "invalid_session_kind");
  } finally { await app.close(); }
});
