import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionOwnerType } from "../src/domain/types.js";
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
  const root = mkdtempSync(join(tmpdir(), "qahwa-message-cancel-"));
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
    cancel: (id: string) => agents.cancelPendingMessage(ownerType, ownerType === "task" ? task.humanId : ownerId, id),
    workspace: () => agents.workspace(ownerType, ownerId),
    idle() {
      database.db.prepare("UPDATE agent_sessions SET run_state = 'idle', active_turn_id = NULL WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
      t.mock.method(agents, "capacity", () => ({ ...capacity, availableSlots: 1 }));
    },
    gate(value: Promise<void>) { gate = value; }, reject() { reject = true; },
    initializeGate(value: Promise<void>) { initializeGate = value; },
    start: (id: string): Promise<boolean> => Reflect.get(agents, "startSavedMessage").call(agents, id),
    actions: (actions: unknown[], quote?: string): Promise<any[]> => Reflect.get(agents, "applyOrchestratorActions").call(agents, actions, quote),
  };
  t.after(() => { agents.close(); attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

for (const ownerType of ["task", "orchestrator"] as const) {
  test(`${ownerType}: cancellation keeps text/files, neighbor order, task state and survives reload`, async t => {
    const f = fixture(t, ownerType), timestamp = new Date().toISOString();
    f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
    const file = f.attachments.initiate(ownerType, f.ownerId, "device", { filename: "context.txt", mediaType: "text/plain", size: 7 });
    f.attachments.appendChunk(file.id, "device", 0, Buffer.from("context")); f.attachments.complete(file.id, "device");
    const first = await f.save("First"), cancelled = await f.save("Keep this text", [file.id]), last = await f.save("Last");
    const foreign = (await f.agents.send("task", f.neighbor.id, "Neighbor message")).messages[0]!;
    f.database.db.prepare("UPDATE pending_messages SET dispatch_order = 5, retry_after = '2099-01-01' WHERE message_id = ?").run(last.id);
    const before = f.database.db.prepare("SELECT * FROM pending_messages WHERE message_id != ? ORDER BY message_id").all(cancelled.id);
    f.database.db.prepare("UPDATE attachment_uploads SET expires_at = '2000-01-01' WHERE id = ?").run(file.id);
    const originalPoll = workspacePoll(f.workspace(), {});
    const saved = f.cancel(cancelled.id).messages.find(m => m.id === cancelled.id)!;
    assert.ok(saved.cancelledAt); assert.equal(saved.pending, false); assert.equal(saved.canCancel, false);
    assert.equal(saved.body, "Keep this text"); assert.equal(saved.metadata?.attachments?.[0]?.status, "available");
    assert.deepEqual(f.database.db.prepare("SELECT * FROM pending_messages ORDER BY message_id").all(), before);
    assert.equal(f.workspace().session.runState, "running"); assert.equal(f.tasks.getTask(f.task.id).status, "todo");
    assert.deepEqual(f.workspace().messages.map(m => m.id), [first.id, cancelled.id, last.id]);
    assert.ok(f.agents.workspace("task", f.neighbor.id).messages.find(m => m.id === foreign.id)?.pending);
    const asset = f.attachments.resolveDownload(ownerType, f.ownerId, file.id);
    assert.equal(readFileSync(asset.path, "utf8"), "context");
    const expiry = f.database.db.prepare("SELECT expires_at AS expiry FROM attachment_uploads WHERE id = ?").get(file.id) as { expiry: string };
    assert.ok(Date.parse(expiry.expiry) >= Date.now() + ATTACHMENT_LIMITS.completedMs - 1500);
    assert.notEqual(workspacePoll(f.workspace(), {}).messagesRevision, originalPoll.messagesRevision);
    f.agents.close();
    const reopenedDb = new AppDatabase(f.config), reopenedFiles = new AttachmentService(reopenedDb, join(f.root, "reopened-files"));
    const reopened = new AgentService(reopenedDb, new TaskService(reopenedDb), reopenedFiles);
    try {
      const message = reopened.workspace(ownerType, f.ownerId).messages.find(m => m.id === cancelled.id)!;
      assert.equal(message.cancelledAt, saved.cancelledAt); assert.equal(message.pending, false);
      assert.equal(await Reflect.get(reopened, "startSavedMessage").call(reopened, cancelled.id), false);
      assert.equal(reopenedFiles.resolveDownload(ownerType, f.ownerId, file.id).attachment.filename, "context.txt");
    } finally { reopened.close(); reopenedFiles.close(); reopenedDb.close(); }
    assert.deepEqual(f.requests, []);
  });

  for (const phase of ["initialize", "turn/start"] as const) test(`${ownerType}: ${phase} reservation wins across connections; messages behind it remain cancellable`, async t => {
    const f = fixture(t, ownerType), first = await f.save("Starting"), next = await f.save("Behind active turn");
    f.idle();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (phase === "initialize") f.initializeGate(gate); else f.gate(gate);
    const starting = f.start(first.id);
    if (phase === "turn/start") {
      await until(() => f.requests.some(r => r.method === "turn/start"));
    }
    const observer = new AppDatabase(f.config);
    try {
      assert.equal((observer.db.prepare("SELECT starting_message_id AS id FROM agent_sessions WHERE owner_type = ? AND owner_id = ?").get(ownerType, f.ownerId) as any).id, first.id);
      assert.equal(f.workspace().messages[0]?.canCancel, false);
      assert.equal(f.workspace().messages[1]?.canCancel, true);
      assert.throws(() => f.cancel(first.id), { code: "message_not_pending", statusCode: 409 });
      assert.throws(() => observer.db.transaction(() => requireMutablePendingMessage(observer, ownerType, f.ownerId, first.id)).immediate(), { code: "message_not_pending" });
      f.cancel(next.id);
      assert.ok((observer.db.prepare("SELECT cancelled_at FROM chat_messages WHERE id = ?").get(next.id) as any).cancelled_at);
      release(); assert.equal(await starting, true);
      assert.throws(() => f.cancel(first.id), { code: "message_not_pending" });
      assert.equal(f.requests.filter(r => r.method === "turn/start").length, 1);
      assert.equal(f.workspace().messages[1]?.cancelledAt !== null, true);
    } finally { release(); await starting; observer.close(); }
  });

  test(`${ownerType}: early completion notification cannot release an in-flight message reservation`, async t => {
    const f = fixture(t, ownerType), message = await f.save(); f.idle();
    let release!: () => void;
    f.gate(new Promise<void>(resolve => { release = resolve; }));
    const starting = f.start(message.id);
    await until(() => f.requests.some(r => r.method === "turn/start"));
    const threadId = f.workspace().session.threadId;
    Reflect.get(f.agents, "handleCodexMessage").call(f.agents, { method: "turn/completed", params: { threadId, turn: { id: "early-turn", status: "completed" } } });
    assert.throws(() => f.cancel(message.id), { code: "message_not_pending" });
    if (ownerType === "task") assert.throws(() => f.tasks.transition(f.task.id, { to: "closed", outcome: "cancelled", onlyIfUnstarted: true }, "user"), { code: "task_running" });
    assert.equal(await f.start(message.id), false);
    release(); assert.equal(await starting, true);
    assert.equal(f.requests.filter(r => r.method === "turn/start").length, 1);
  });

  test(`${ownerType}: waiting on an active turn still allows cancelling a later pending message`, async t => {
    const f = fixture(t, ownerType), message = await f.save();
    f.database.db.prepare("UPDATE agent_sessions SET run_state = 'waiting', active_turn_id = 'active' WHERE owner_type = ? AND owner_id = ?").run(ownerType, f.ownerId);
    f.cancel(message.id);
    assert.equal(f.workspace().session.runState, "waiting"); assert.equal(f.workspace().session.activeTurnId, "active");
    assert.ok(f.workspace().messages[0]?.cancelledAt);
  });

  test(`${ownerType}: cancellation wins against stale dispatch and retries`, async t => {
    const f = fixture(t, ownerType), first = await f.save("Never deliver"), next = await f.save("Next in order");
    f.cancel(first.id); f.idle();
    await f.actions([{ type: "dispatch", messageIds: [first.id, next.id] }]);
    assert.equal(await f.start(first.id), false);
    assert.equal(f.database.db.prepare("SELECT 1 FROM pending_messages WHERE message_id = ?").get(first.id), undefined);
    assert.equal(await f.start(next.id), true);
    const input = JSON.stringify(f.requests.filter(r => r.method === "turn/start"));
    assert.ok(input.includes("Next in order")); assert.ok(!input.includes("Never deliver"));
    assert.throws(() => f.cancel(first.id), { code: "message_not_pending" });
  });

  test(`${ownerType}: failed startup releases reservation; cancelling suppresses delayed retry`, async t => {
    const f = fixture(t, ownerType), message = await f.save(); f.idle(); f.reject();
    assert.equal(await f.start(message.id), false);
    assert.equal(f.workspace().messages[0]?.canCancel, true);
    assert.ok((f.database.db.prepare("SELECT retry_after FROM pending_messages WHERE message_id = ?").get(message.id) as any).retry_after);
    f.cancel(message.id);
    const count = f.requests.length;
    await Reflect.get(f.agents, "drainPendingMessages").call(f.agents);
    assert.equal(await f.start(message.id), false); assert.equal(f.requests.length, count);
  });

  test(`${ownerType}: cancellation rolls back history, queue, files and activity together`, async t => {
    const f = fixture(t, ownerType), timestamp = new Date().toISOString();
    f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
    const file = f.attachments.initiate(ownerType, f.ownerId, "device", { filename: "keep.txt", mediaType: "text/plain", size: 4 });
    f.attachments.appendChunk(file.id, "device", 0, Buffer.from("keep")); f.attachments.complete(file.id, "device");
    const message = await f.save("Keep files", [file.id]);
    f.database.db.prepare("UPDATE attachment_uploads SET expires_at = '2000-01-01' WHERE id = ?").run(file.id);
    const before = f.workspace();
    f.database.db.exec("CREATE TRIGGER fail_cancel BEFORE DELETE ON pending_messages BEGIN SELECT RAISE(ABORT, 'cancel storage failed'); END");
    assert.throws(() => f.cancel(message.id), /cancel storage failed/);
    assert.deepEqual(f.workspace(), before);
    assert.equal((f.database.db.prepare("SELECT expires_at FROM attachment_uploads WHERE id = ?").get(file.id) as any).expires_at, "2000-01-01");
    assert.equal(f.database.db.prepare("SELECT 1 FROM session_events WHERE event_type = 'message.cancelled'").get(), undefined);
    f.database.db.exec("DROP TRIGGER fail_cancel; CREATE TRIGGER fail_event BEFORE INSERT ON session_events WHEN NEW.event_type = 'message.cancelled' BEGIN SELECT RAISE(ABORT, 'event storage failed'); END");
    assert.throws(() => f.cancel(message.id), /event storage failed/); assert.deepEqual(f.workspace(), before);
    f.database.db.exec("DROP TRIGGER fail_event"); f.cancel(message.id);
    assert.ok(f.workspace().messages[0]?.cancelledAt);
  });

  test(`${ownerType}: failed reservation storage rolls back before any RPC`, async t => {
    const f = fixture(t, ownerType), message = await f.save(); f.idle();
    f.database.db.exec("CREATE TRIGGER fail_reservation BEFORE UPDATE OF starting_message_id ON agent_sessions BEGIN SELECT RAISE(ABORT, 'reservation storage failed'); END");
    await assert.rejects(f.start(message.id), /reservation storage failed/);
    assert.equal(f.workspace().session.runState, "idle"); assert.equal(f.workspace().messages[0]?.pending, true);
    assert.equal(f.workspace().messages[0]?.canCancel, true); assert.deepEqual(f.requests, []);
    f.database.db.exec("DROP TRIGGER fail_reservation"); f.cancel(message.id);
  });

  test(`${ownerType}: rejects other chats, system history, read messages and closed tasks`, async t => {
    const f = fixture(t, ownerType), message = await f.save(), system = await f.save("Internal", [], "system");
    assert.throws(() => f.agents.cancelPendingMessage("task", f.neighbor.id, message.id), { code: "message_not_found" });
    assert.throws(() => f.agents.cancelPendingMessage(ownerType === "task" ? "orchestrator" : "task", ownerType === "task" ? "main" : f.task.id, message.id), { code: "message_not_found" });
    assert.throws(() => f.cancel(system.id), { code: "message_not_pending" });
    assert.throws(() => f.cancel("missing"), { code: "message_not_found" });
    f.database.db.prepare("DELETE FROM pending_messages WHERE message_id = ?").run(message.id);
    assert.throws(() => f.cancel(message.id), { code: "message_not_pending" });
    if (ownerType === "task") {
      const pending = await f.save();
      f.database.db.prepare("UPDATE tasks SET status = 'closed', outcome = 'cancelled' WHERE id = ?").run(f.task.id);
      assert.equal(f.workspace().messages.at(-1)?.canCancel, false);
      assert.throws(() => f.cancel(pending.id), { code: "message_not_pending" });
    }
  });
}

test("cancelled orchestrator history cannot authorize later actions", async t => {
  const f = fixture(t, "orchestrator"), quote = "Prioritize my neighbor task";
  const message = await f.save(quote); f.cancel(message.id);
  const outcome = await f.actions([{ type: "priority", taskIds: [f.neighbor.id], authorization: quote }], "Continue");
  assert.equal(outcome[0].status, "failed"); assert.match(outcome[0].message, /not authorized/);
});

test("cancelled task history is excluded from both implementation handoff paths", async t => {
  const f = fixture(t, "task"), secret = "Cancelled instructions must not reach implementation";
  const cancelled = await f.save(secret); f.cancel(cancelled.id); f.idle();
  assert.ok(!JSON.stringify(Reflect.get(f.agents, "orchestratorSnapshot").call(f.agents)).includes(secret));
  f.database.db.prepare("UPDATE agent_sessions SET intake_state = 'ready' WHERE owner_type = 'task' AND owner_id = ?").run(f.ownerId);
  await Reflect.get(f.agents, "beginImplementation").call(f.agents, f.ownerId);
  assert.ok(!JSON.stringify(f.requests).includes(secret));
  f.idle();
  f.database.db.prepare("INSERT INTO scheduler_queue (task_id, requested_by, reason, created_at) VALUES (?, 'intake', 'Ready', ?)").run(f.ownerId, new Date().toISOString());
  await f.save("Valid follow-up");
  assert.ok(!JSON.stringify(f.requests).includes(secret));
  assert.ok(JSON.stringify(f.requests).includes("Valid follow-up"));
});

test("authenticated cancellation endpoints validate origin and canonical chat ownership", async t => {
  const f = fixture(t, "task"); f.agents.close();
  const timestamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  t.mock.method(AgentService.prototype, "capacity", () => ({ ...f.agents.capacity(), availableSlots: 0 }));
  const app = await buildApp(f.config, f.database);
  try {
    for (const [base, ownerType, ownerId] of [[`/api/tasks/${f.task.humanId}`, "task", f.task.id], ["/api/orchestrator", "orchestrator", "main"]]) {
      const id = `message-${ownerType}`;
      f.database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES (?, ?, ?, 'user', 'Saved', ?)").run(id, ownerType, ownerId, timestamp);
      f.database.db.prepare("INSERT INTO pending_messages (message_id) VALUES (?)").run(id);
      const url = `${base}/messages/${id}/cancel`;
      assert.equal((await app.inject({ method: "POST", url })).statusCode, 401);
      assert.equal((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://foreign.test" } })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${f.neighbor.id}/messages/${id}/cancel`, headers })).statusCode, 404);
      const response = await app.inject({ method: "POST", url, headers });
      assert.equal(response.statusCode, 200, response.body);
      const message = response.json().workspace.messages.find((m: any) => m.id === id);
      assert.ok(message.cancelledAt); assert.equal(message.pending, false);
      assert.equal((await app.inject({ method: "POST", url, headers })).statusCode, 409);
    }
  } finally { await app.close(); }
});

test("existing message/session databases migrate without losing history", t => {
  const f = fixture(t, "task"); f.agents.close();
  f.database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES ('legacy', 'task', ?, 'user', 'Retain history', ?)").run(f.ownerId, new Date().toISOString());
  f.database.db.exec("ALTER TABLE chat_messages DROP COLUMN cancelled_at; ALTER TABLE agent_sessions DROP COLUMN starting_message_id");
  const reopened = new AppDatabase(f.config);
  try {
    assert.deepEqual(reopened.db.prepare("SELECT body, cancelled_at FROM chat_messages WHERE id = 'legacy'").get(), { body: "Retain history", cancelled_at: null });
    assert.equal((reopened.db.prepare("SELECT starting_message_id FROM agent_sessions WHERE owner_id = ?").get(f.ownerId) as any).starting_message_id, null);
  } finally { reopened.close(); }
});
