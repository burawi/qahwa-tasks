import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionOwnerType } from "../src/domain/types.js";
import { documentFromPlainText, plainTextFromDocument } from "../src/domain/types.js";
import { AgentService } from "../src/server/agent-service.js";
import { ATTACHMENT_LIMITS, AttachmentService } from "../src/server/attachment-service.js";
import { AuthService } from "../src/server/auth.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { buildApp } from "../src/server/app.js";
import { workspacePoll } from "../src/server/workspace-poll.js";
import { requireMutablePendingMessage } from "../src/server/pending-message.js";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Mock startup did not reach turn/start");
    await new Promise(resolve => setImmediate(resolve));
  }
}

function fixture(t: TestContext, ownerType: SessionOwnerType) {
  // Constructors must not resume queues through a real Codex transport.
  t.mock.method(AgentService.prototype as any, "monitorPortfolio", async () => {});
  const root = mkdtempSync(join(tmpdir(), "qahwa-saved-edit-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config), tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Message cancellation", prefix: "MSG", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Keep the task", status: "todo" }, "user");
  const neighbor = tasks.createTask({ projectId: project.id, title: "Neighbor", status: "todo" }, "user");
  const attachments = new AttachmentService(database, join(root, "files"));
  const agents = new AgentService(database, tasks, attachments);
  const ownerId = ownerType === "task" ? task.id : "main";
  agents.workspace(ownerType, ownerId);
  // Queue user control messages too, without invoking a real Codex process.
  database.db.prepare("UPDATE agent_sessions SET run_state = 'running' WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
  let gate: Promise<void> | undefined, reject = false, initializeGate: Promise<void> | undefined;
  const requests: Array<{ method: string; params: any }> = [];
  const client = Reflect.get(agents, "codex");
  t.mock.method(client, "initialize", async () => { await initializeGate; });
  t.mock.method(client, "request", async (method: string, params: unknown) => {
    requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${requests.length}` } };
    if (method === "turn/start") { await gate; if (reject) throw new Error("Start failed"); return { turn: { id: `turn-${requests.length}` } }; }
    return {};
  });
  const capacity = agents.capacity();
  t.mock.method(agents, "capacity", () => ({ ...capacity, availableSlots: 0 }));
  const f = {
    root, config, database, tasks, task, neighbor, attachments, agents, ownerType, ownerId, requests,
    save: async (body = "Saved message", ids: string[] = [], role: "user" | "system" = "user") => (await agents.send(ownerType, ownerId, body, false, role, ids, "device")).messages.at(-1)!,
    edit: (id: string, message: unknown, expectedVersion: unknown = 1) => agents.editPendingMessage(ownerType, ownerType === "task" ? task.humanId : ownerId, id, { message, expectedVersion }),
    cancel: (id: string) => agents.cancelPendingMessage(ownerType, ownerType === "task" ? task.humanId : ownerId, id),
    workspace: () => agents.workspace(ownerType, ownerId),
    idle() {
      database.db.prepare("UPDATE agent_sessions SET run_state = 'idle', active_turn_id = NULL WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
      t.mock.method(agents, "capacity", () => ({ ...capacity, availableSlots: 1 }));
    },
    gate(value: Promise<void>) { gate = value; }, reject(value = true) { reject = value; },
    initializeGate(value: Promise<void>) { initializeGate = value; },
    start: (id: string): Promise<boolean> => Reflect.get(agents, "startSavedMessage").call(agents, id),
    actions: (actions: unknown[], quote?: string): Promise<any[]> => Reflect.get(agents, "applyOrchestratorActions").call(agents, actions, quote),
  };
  t.after(() => { agents.close(); attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

for (const ownerType of ["task", "orchestrator"] as const) {
  test(`${ownerType}: edits preserve identity, files, context, queue position and durable version history`, async t => {
    const f = fixture(t, ownerType), timestamp = new Date().toISOString();
    f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
    const file = f.attachments.initiate(ownerType, f.ownerId, "device", { filename: "context.txt", mediaType: "text/plain", size: 7 });
    f.attachments.appendChunk(file.id, "device", 0, Buffer.from("context")); f.attachments.complete(file.id, "device");
    const first = await f.save("First"), message = await f.save("Original instructions", [file.id]), last = await f.save("Last");
    const metadata = { ...message.metadata, selectedTasks: [{ id: f.neighbor.id, humanId: f.neighbor.humanId, title: f.neighbor.title }], selectedExcerpt: { messageId: first.id, excerpt: "First", role: "user" }, designPageId: null };
    f.database.db.prepare("UPDATE chat_messages SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), message.id);
    f.database.db.prepare("UPDATE pending_messages SET dispatch_order = 8, retry_after = '2099-01-01', last_error = 'Try later' WHERE message_id = ?").run(message.id);
    const before = f.workspace(), queue = f.database.db.prepare("SELECT * FROM pending_messages ORDER BY message_id").all();
    const saved = f.edit(message.id, "  Revised instructions  ").messages.find(m => m.id === message.id)!;
    assert.equal(saved.body, "Revised instructions"); assert.equal(saved.version, 2); assert.ok(saved.editedAt);
    assert.equal(saved.createdAt, message.createdAt); assert.deepEqual(saved.metadata, before.messages[1]!.metadata);
    assert.deepEqual(f.database.db.prepare("SELECT * FROM pending_messages ORDER BY message_id").all(), queue);
    assert.deepEqual(f.workspace().messages.map(m => m.id), [first.id, message.id, last.id]);
    assert.equal(f.workspace().session.runState, "running"); assert.equal(f.tasks.getTask(f.task.id).status, "todo");
    assert.notEqual(workspacePoll(f.workspace(), {}).messagesRevision, workspacePoll(before, {}).messagesRevision);
    assert.deepEqual(f.database.db.prepare("SELECT version, body FROM chat_message_versions WHERE message_id = ? ORDER BY version").all(message.id), [{ version: 1, body: "Original instructions" }, { version: 2, body: "Revised instructions" }]);
    assert.equal(readFileSync(f.attachments.resolveDownload(ownerType, f.ownerId, file.id).path, "utf8"), "context");
    assert.deepEqual(f.requests, [], "Saving must not deliver or start anything");
    f.agents.close();
    const db = new AppDatabase(f.config), files = new AttachmentService(db, join(f.root, "reload-files"));
    const agents = new AgentService(db, new TaskService(db), files);
    t.mock.method(Reflect.get(agents, "codex"), "initialize", async () => { throw new Error("Isolated reload"); });
    try {
      const reloaded = agents.workspace(ownerType, f.ownerId).messages.find(m => m.id === message.id)!;
      assert.equal(reloaded.version, 2); assert.equal(reloaded.body, saved.body); assert.equal(reloaded.editedAt, saved.editedAt);
      agents.cancelPendingMessage(ownerType, f.ownerId, message.id);
      assert.throws(() => agents.editPendingMessage(ownerType, f.ownerId, message.id, { message: "Too late", expectedVersion: 2 }), { code: "message_not_pending" });
    } finally { agents.close(); files.close(); db.close(); }
  });

  for (const phase of ["initialize", "turn/start"] as const) test(`${ownerType}: ${phase} reservation rejects edits; later pending messages remain editable`, async t => {
    const f = fixture(t, ownerType), first = await f.save("Original"), next = await f.save("Behind active turn");
    f.edit(first.id, "Latest saved instruction"); f.idle();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (phase === "initialize") f.initializeGate(gate); else f.gate(gate);
    const starting = f.start(first.id);
    try {
      if (phase === "turn/start") await until(() => f.requests.some(r => r.method === "turn/start"));
      const observer = new AppDatabase(f.config);
      try { assert.throws(() => observer.db.transaction(() => requireMutablePendingMessage(observer, ownerType, f.ownerId, first.id)).immediate(), { code: "message_not_pending" }); }
      finally { observer.close(); }
      assert.throws(() => f.edit(first.id, "Too late", 2), { code: "message_not_pending", statusCode: 409 });
      assert.equal(f.edit(next.id, "Edited behind turn").messages[1]!.body, "Edited behind turn");
      assert.equal(f.workspace().messages[0]?.canEdit, false); assert.equal(f.workspace().messages[1]?.canEdit, true);
      release(); assert.equal(await starting, true);
      const turns = f.requests.filter(r => r.method === "turn/start");
      assert.equal(turns.length, 1); assert.match(JSON.stringify(turns), /Latest saved instruction/); assert.doesNotMatch(JSON.stringify(turns), /Edited behind turn|Too late/);
      assert.equal(await f.start(first.id), false, "No duplicate delivery");
      assert.throws(() => f.edit(first.id, "Already read", 2), { code: "message_not_pending" });
    } finally { release(); await starting; }
  });

  test(`${ownerType}: version, ownership, cancellation, read state and invalid input reject without mutation`, async t => {
    const f = fixture(t, ownerType), message = await f.save(), system = await f.save("Internal", [], "system");
    const edited = f.edit(message.id, "Newest");
    for (const version of [0, -1, "2", undefined, null, 1.5]) assert.throws(() => f.edit(message.id, "Invalid", version === undefined ? null : version), { code: "invalid_version" });
    assert.throws(() => f.edit(message.id, "Stale", 1), { code: "version_conflict" });
    for (const body of ["", "   ", "a".repeat(30_001), 42, null]) assert.throws(() => f.edit(message.id, body, 2), { code: "invalid_message" });
    assert.throws(() => f.agents.editPendingMessage("task", f.neighbor.id, message.id, { message: "Foreign", expectedVersion: 2 }), { code: "message_not_found" });
    assert.throws(() => f.agents.editPendingMessage(ownerType === "task" ? "orchestrator" : "task", ownerType === "task" ? "main" : f.task.id, message.id, { message: "Foreign", expectedVersion: 2 }), { code: "message_not_found" });
    assert.throws(() => f.edit(system.id, "System"), { code: "message_not_pending" });
    assert.deepEqual(f.workspace(), edited);
    f.cancel(message.id); assert.throws(() => f.edit(message.id, "Cancelled", 2), { code: "message_not_pending" });
    const read = await f.save(); f.database.db.prepare("DELETE FROM pending_messages WHERE message_id = ?").run(read.id);
    assert.throws(() => f.edit(read.id, "Read"), { code: "message_not_pending" });
    if (ownerType === "task") {
      const pending = await f.save(); f.database.db.prepare("UPDATE tasks SET status = 'closed', outcome = 'cancelled' WHERE id = ?").run(f.task.id);
      assert.throws(() => f.edit(pending.id, "Closed"), { code: "message_not_pending" });
      assert.equal(f.workspace().messages.at(-1)?.canEdit, false);
    }
  });

  test(`${ownerType}: message, versions and audit rollback together; retries deliver only the latest text`, async t => {
    const f = fixture(t, ownerType), message = await f.save("Before failure");
    const before = f.workspace();
    f.database.db.exec("CREATE TRIGGER fail_edit BEFORE INSERT ON session_events WHEN NEW.event_type = 'message.edited' BEGIN SELECT RAISE(ABORT, 'edit audit failed'); END");
    assert.throws(() => f.edit(message.id, "Rolled back"), /edit audit failed/);
    assert.deepEqual(f.workspace(), before); assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM chat_message_versions").get().n, 0);
    f.database.db.exec("DROP TRIGGER fail_edit");
    f.idle(); f.reject(); assert.equal(await f.start(message.id), false);
    const retry = f.database.db.prepare("SELECT * FROM pending_messages WHERE message_id = ?").get(message.id);
    f.edit(message.id, "After failed startup");
    assert.deepEqual(f.database.db.prepare("SELECT * FROM pending_messages WHERE message_id = ?").get(message.id), retry);
    assert.equal(f.workspace().messages[0]?.body, "After failed startup");
    f.reject(false); assert.equal(await f.start(message.id), true);
    const turns = f.requests.filter(r => r.method === "turn/start");
    assert.match(JSON.stringify(turns.at(-1)), /After failed startup/);
    assert.doesNotMatch(JSON.stringify(turns.at(-1)), /Before failure|Rolled back/);
    assert.equal(await f.start(message.id), false);
  });
}

for (const status of ["backlog", "todo"] as const) test(`${status}: task edits retain queue/history, persist versions and feed the latest charter into startup`, async t => {
  const f = fixture(t, "task");
  f.database.db.prepare("UPDATE agent_sessions SET run_state = 'not_started' WHERE owner_type = 'task' AND owner_id = ?").run(f.task.id);
  f.database.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, f.task.id);
  f.database.db.prepare("INSERT INTO scheduler_queue (task_id, requested_by, reason, created_at) VALUES (?, 'orchestrator', 'Keep position', ?)").run(f.task.id, new Date().toISOString());
  const pending = await f.save("A separate pending instruction");
  const original = f.tasks.getTask(f.task.id);
  assert.equal(original.canEdit, true);
  const queue = f.database.db.prepare("SELECT * FROM scheduler_queue").all(), messages = f.workspace().messages;
  const saved = f.tasks.updateTask(f.task.humanId, { title: "Revised task title", description: documentFromPlainText("The latest task description"), expectedVersion: original.version }, "user");
  assert.equal(saved.version, original.version + 1); assert.equal(saved.title, "Revised task title"); assert.equal(saved.id, original.id);
  assert.equal(saved.status, status); assert.equal(saved.rank, original.rank); assert.equal(saved.createdAt, original.createdAt);
  assert.deepEqual(f.database.db.prepare("SELECT * FROM scheduler_queue").all(), queue); assert.deepEqual(f.workspace().messages, messages);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM task_versions WHERE task_id = ?").get(f.task.id).n, 2);
  assert.deepEqual(f.requests, []);
  const observer = new AppDatabase(f.config), peer = new TaskService(observer);
  try {
    assert.equal(peer.getTask(f.task.id).title, saved.title);
    assert.throws(() => peer.updateTask(f.task.id, { title: "Stale task", expectedVersion: original.version }, "user"), { code: "version_conflict" });
    f.idle();
    // Leave the unrelated pending message queued; task startup must use the edited description.
    const started = await f.agents.triggerTask(f.task.humanId);
    assert.equal(started.messages.find(m => m.id === pending.id)?.body, "A separate pending instruction");
    const initial = started.messages.at(-1)!;
    assert.equal(initial.body, "The latest task description");
    assert.throws(() => peer.updateTask(f.task.id, { title: "Too late", expectedVersion: saved.version }, "user"), { code: "task_started" });
    assert.equal(peer.getTask(f.task.id).canEdit, false);
  } finally { observer.close(); }
});

test("task edits reject startup, historical startup and cancellation even when content version is unchanged", async t => {
  const f = fixture(t, "task");
  const version = f.task.version;
  assert.throws(() => f.tasks.updateTask(f.task.id, { title: "Running", expectedVersion: version }, "user"), { code: "task_started" });
  f.database.db.prepare("UPDATE agent_sessions SET run_state = 'not_started', starting_message_id = 'reserved' WHERE owner_type = 'task' AND owner_id = ?").run(f.task.id);
  assert.throws(() => f.tasks.updateTask(f.task.id, { title: "Reserved", expectedVersion: version }, "user"), { code: "task_started" });
  f.database.db.prepare("UPDATE agent_sessions SET starting_message_id = NULL WHERE owner_type = 'task' AND owner_id = ?").run(f.task.id);
  f.database.db.prepare("INSERT INTO session_events (owner_type, owner_id, event_type, payload_json, created_at) VALUES ('task', ?, 'turn.started', '{}', ?)").run(f.task.id, new Date().toISOString());
  assert.equal(f.tasks.getTask(f.task.id).canEdit, false);
  assert.throws(() => f.tasks.updateTask(f.task.id, { title: "History", expectedVersion: version }, "user"), { code: "task_started" });
  f.database.db.prepare("DELETE FROM session_events").run();
  f.tasks.transition(f.task.id, { to: "closed", outcome: "cancelled", onlyIfUnstarted: true }, "user");
  assert.throws(() => f.tasks.updateTask(f.task.id, { title: "Cancelled", expectedVersion: version }, "user"), { code: "task_started" });
  assert.equal(f.tasks.getTask(f.task.id).version, version);
});

test("task edit rollback includes content, versions and activity", async t => {
  const f = fixture(t, "task");
  f.database.db.prepare("UPDATE agent_sessions SET run_state = 'not_started' WHERE owner_type = 'task' AND owner_id = ?").run(f.task.id);
  const before = f.tasks.getTask(f.task.id), history = f.database.db.prepare("SELECT * FROM task_versions").all(), activity = f.database.db.prepare("SELECT * FROM activity").all();
  for (const table of ["task_versions", "activity"]) {
    f.database.db.exec(`CREATE TRIGGER fail_task_edit BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'task storage failed'); END`);
    assert.throws(() => f.tasks.updateTask(f.task.id, { title: "Discarded", description: documentFromPlainText("Discarded description"), expectedVersion: before.version }, "user"), /task storage failed/);
    assert.deepEqual(f.tasks.getTask(f.task.id), before); assert.deepEqual(f.database.db.prepare("SELECT * FROM task_versions").all(), history); assert.deepEqual(f.database.db.prepare("SELECT * FROM activity").all(), activity);
    f.database.db.exec("DROP TRIGGER fail_task_edit");
  }
});

test("edited pending authority replaces the old text and only becomes usable after delivery", async t => {
  const f = fixture(t, "orchestrator"), old = "Prioritize the neighbor", current = "Prioritize the other saved task";
  const message = await f.save(old); f.edit(message.id, current);
  assert.equal((await f.actions([{ type: "priority", taskIds: [f.neighbor.id], authorization: current }], "Continue"))[0].status, "failed");
  f.idle(); assert.equal(await f.start(message.id), true);
  assert.equal((await f.actions([{ type: "priority", taskIds: [f.neighbor.id], authorization: old }], "Continue"))[0].status, "failed");
  assert.equal((await f.actions([{ type: "priority", taskIds: [f.neighbor.id], authorization: current }], "Continue"))[0].status, "applied");
});

test("edited pending instructions enter implementation once, at their own reservation", async t => {
  const f = fixture(t, "task");
  const message = await f.save("Outdated pending instruction");
  f.edit(message.id, "Latest pending instruction"); f.idle();
  f.database.db.prepare("UPDATE agent_sessions SET intake_state = 'ready' WHERE owner_type = 'task' AND owner_id = ?").run(f.ownerId);
  await Reflect.get(f.agents, "beginImplementation").call(f.agents, f.ownerId);
  const handoff = JSON.stringify(f.requests.filter(r => r.method === "turn/start"));
  assert.doesNotMatch(handoff, /Outdated pending instruction|Latest pending instruction/, "Pending text must not be copied early into a handoff");
  f.idle(); assert.equal(await f.start(message.id), true);
  assert.match(JSON.stringify(f.requests.at(-1)), /Latest pending instruction/);
  assert.doesNotMatch(JSON.stringify(f.requests), /Outdated pending instruction/);
});

test("authenticated edit endpoints enforce chat ownership, origin, input and optimistic versions", async t => {
  const f = fixture(t, "task"); f.agents.close();
  const timestamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const capacity = f.agents.capacity();
  t.mock.method(AgentService.prototype, "capacity", () => ({ ...capacity, availableSlots: 0 }));
  const app = await buildApp(f.config, f.database);
  try {
    for (const [base, ownerType, ownerId] of [[`/api/tasks/${f.task.humanId}`, "task", f.task.id], ["/api/orchestrator", "orchestrator", "main"]]) {
      const id = `edit-${ownerType}`, url = `${base}/messages/${id}`, payload = { message: "Edited through API", expectedVersion: 1 };
      f.database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES (?, ?, ?, 'user', 'Saved', ?)").run(id, ownerType, ownerId, timestamp);
      f.database.db.prepare("INSERT INTO pending_messages (message_id) VALUES (?)").run(id);
      assert.equal((await app.inject({ method: "PATCH", url, payload })).statusCode, 401);
      assert.equal((await app.inject({ method: "PATCH", url, payload, headers: { ...headers, origin: "https://foreign.test" } })).statusCode, 403);
      assert.equal((await app.inject({ method: "PATCH", url: `/api/tasks/${f.neighbor.id}/messages/${id}`, payload, headers })).statusCode, 404);
      for (const bad of [{ message: "Missing version" }, { expectedVersion: 1, message: 5 }]) assert.equal((await app.inject({ method: "PATCH", url, payload: bad, headers })).statusCode, 400);
      const response = await app.inject({ method: "PATCH", url, payload, headers }); assert.equal(response.statusCode, 200, response.body);
      const message = response.json().workspace.messages.find((m: any) => m.id === id);
      assert.equal(message.version, 2); assert.equal(message.pending, true); assert.equal(message.body, payload.message);
      assert.equal((await app.inject({ method: "PATCH", url, payload, headers })).statusCode, 409);
    }
    f.database.db.prepare("UPDATE agent_sessions SET run_state = 'not_started' WHERE owner_type = 'task' AND owner_id = ?").run(f.task.id);
    const url = `/api/tasks/${f.task.humanId}`, payload = { title: "API edited title", description: documentFromPlainText("API edited note"), expectedVersion: 1 };
    assert.equal((await app.inject({ method: "PATCH", url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "PATCH", url, payload, headers: { ...headers, origin: "https://foreign.test" } })).statusCode, 403);
    const response = await app.inject({ method: "PATCH", url, payload, headers }); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().task.title, payload.title); assert.equal(plainTextFromDocument(response.json().task.description), "API edited note");
    assert.equal((await app.inject({ method: "PATCH", url, payload, headers })).statusCode, 409);
    f.tasks.transition(f.task.id, { to: "in_progress" }, "codex");
    assert.equal((await app.inject({ method: "PATCH", url, payload: { ...payload, expectedVersion: 2 }, headers })).statusCode, 409);
  } finally { await app.close(); }
});

test("legacy messages migrate to an editable version without changing body, timestamp or queue", t => {
  const f = fixture(t, "task"); f.agents.close();
  const stamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES ('legacy-edit', 'task', ?, 'user', 'Legacy text', ?)").run(f.ownerId, stamp);
  f.database.db.prepare("INSERT INTO pending_messages (message_id, dispatch_order) VALUES ('legacy-edit', 7)").run();
  f.database.db.exec("ALTER TABLE chat_messages DROP COLUMN version; ALTER TABLE chat_messages DROP COLUMN edited_at; DROP TABLE chat_message_versions");
  const db = new AppDatabase(f.config);
  try {
    assert.deepEqual(db.db.prepare("SELECT body, version, edited_at, created_at FROM chat_messages WHERE id = 'legacy-edit'").get(), { body: "Legacy text", version: 1, edited_at: null, created_at: stamp });
    assert.equal(db.db.prepare("SELECT dispatch_order FROM pending_messages WHERE message_id = 'legacy-edit'").get().dispatch_order, 7);
    assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_message_versions'").get());
  } finally { db.close(); }
});

test("task startup captures the edited charter and rejects a competing edit before RPC acknowledgement", async t => {
  const f = fixture(t, "task");
  f.database.db.prepare("UPDATE agent_sessions SET run_state = 'not_started' WHERE owner_type = 'task' AND owner_id = ?").run(f.task.id);
  const edited = f.tasks.updateTask(f.task.id, { title: "Current task charter", description: documentFromPlainText("Only the latest task content"), expectedVersion: 1 }, "user");
  f.idle();
  let release!: () => void;
  f.initializeGate(new Promise<void>(resolve => { release = resolve; }));
  const starting = f.agents.triggerTask(f.task.id);
  const observer = new AppDatabase(f.config), peer = new TaskService(observer);
  try {
    assert.throws(() => peer.updateTask(f.task.humanId, { description: documentFromPlainText("Late change"), expectedVersion: edited.version }, "user"), { code: "task_started" });
    assert.equal(f.requests.length, 0, "Startup is reserved before the first RPC");
    release(); await starting;
    const prompt = JSON.stringify(f.requests.filter(r => r.method === "turn/start"));
    assert.match(prompt, /Only the latest task content/); assert.match(prompt, /Current task charter/); assert.doesNotMatch(prompt, /Late change/);
    assert.equal(f.requests.filter(r => r.method === "turn/start").length, 1);
  } finally { release(); await starting; observer.close(); }
});
