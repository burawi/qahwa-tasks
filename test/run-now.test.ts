import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionOwnerType } from "../src/domain/types.js";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import { workspacePoll } from "../src/server/workspace-poll.js";
function fixture(t: TestContext, ownerType: SessionOwnerType) {
  const root = mkdtempSync(join(tmpdir(), "qahwa-run-now-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config), tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Run now", prefix: "RUN", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Direct execution", status: "in_progress" }, "user");
  const neighbor = tasks.createTask({ projectId: project.id, title: "Other conversation", status: "todo" }, "user");
  const attachments = new AttachmentService(database, join(root, "files"));
  const agents = new AgentService(database, tasks, attachments), ownerId = ownerType === "task" ? task.id : "main";
  agents.workspace(ownerType, ownerId);
  database.db.prepare("UPDATE agent_sessions SET run_state='running', intake_state='ready', thread_id='existing-thread' WHERE owner_type=? AND owner_id=?").run(ownerType, ownerId);
  const snapshot = agents.capacity();
  let slots = 0, gate: Promise<void> | undefined, rejectStart = false;
  t.mock.method(agents, "capacity", () => ({ ...snapshot, availableSlots: slots }));
  const requests: {
    method: string;
    params: any;
  }[] = [], client = Reflect.get(agents, "codex");
  t.mock.method(client, "initialize", async () => { await gate; });
  t.mock.method(client, "request", async (method: string, params: unknown) => {
    requests.push({ method, params });
    if (method === "thread/start")
      return { thread: { id: "new-thread" } };
    if (method === "turn/start") {
      if (rejectStart)
        throw new Error("Temporary turn failure");
      return { turn: { id: `turn-${requests.length}` } };
    }
    return {};
  });
  const f = { root, config, database, tasks, task, neighbor, attachments, agents, ownerType, ownerId, requests, snapshot,
    save: async (body = "Saved work", ids: string[] = []) => (await agents.send(ownerType, ownerId, body, false, "user", ids, "device")).messages.at(-1)!,
    run: (id: string) => agents.runPendingMessageNow(ownerType, ownerType === "task" ? task.humanId : ownerId, id),
    idle() { slots = 1; database.db.prepare("UPDATE agent_sessions SET run_state='idle',active_turn_id=NULL WHERE owner_type=? AND owner_id=?").run(ownerType, ownerId); },
    slots(n: number) { slots = n; }, gate(p: Promise<void> | undefined) { gate = p; }, reject(value: boolean) { rejectStart = value; },
  };
  t.after(() => { agents.close(); attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}
for (const mode of ["task", "orchestrator"] as const) {
  test(`${mode}: Run now starts the chosen saved message and preserves its files, context, and neighbors`, async (t) => {
    const f = fixture(t, mode);
    const timestamp = new Date().toISOString();
    f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(timestamp, timestamp);
    const file = f.attachments.initiate(mode, f.ownerId, "device", { filename: "context.txt", size: 7, mediaType: "text/plain" });
    f.attachments.appendChunk(file.id, "device", 0, Buffer.from("context"));
    f.attachments.complete(file.id, "device");
    const first = await f.save("Older saved message"), selected = await f.save("Run this chosen message", [file.id]), last = await f.save("Later saved message");
    const metadata = { ...selected.metadata, selectedExcerpt: { messageId: first.id, excerpt: first.body, role: "user" } };
    if (mode === "task") {
      const page = f.agents.createDesignPage(f.ownerId, "Saved page").designPages[0]!;
      Object.assign(metadata, { designPageId: page.id });
      f.agents.createDesignPage(f.ownerId, "Different current page");
    }
    else
      Object.assign(metadata, { selectedTasks: [{ id: f.task.id, humanId: f.task.humanId, title: f.task.title }] });
    f.database.db.prepare("UPDATE chat_messages SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), selected.id);
    f.database.db.prepare("UPDATE pending_messages SET retry_after='2099-01-01',last_error='Old failure' WHERE message_id=?").run(selected.id);
    const neighbors = f.database.db.prepare("SELECT * FROM pending_messages WHERE message_id!=? ORDER BY message_id").all(selected.id);
    const poll = workspacePoll(f.agents.workspace(mode, f.ownerId), {});
    f.idle();
    if (mode === "task")
      f.database.db.prepare("UPDATE agent_sessions SET run_state='running' WHERE owner_type='orchestrator'").run();
    const w = await f.run(selected.id), delivered = w.messages.find(m => m.id === selected.id)!;
    assert.equal(w.messages.length, 3);
    assert.equal(delivered.pending, false);
    assert.equal(delivered.canRunNow, false);
    assert.equal(delivered.body, selected.body);
    assert.deepEqual(delivered.metadata?.selectedExcerpt, metadata.selectedExcerpt);
    assert.equal(delivered.metadata?.attachments?.[0]?.status, "available");
    assert.deepEqual(f.database.db.prepare("SELECT * FROM pending_messages ORDER BY message_id").all(), neighbors);
    assert.equal(w.session.threadId, "existing-thread");
    assert.equal(w.session.runState, "running");
    assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
    const prompt = f.requests.find(r => r.method === 'turn/start')!.params.input[0].text;
    assert.match(prompt, /Run this chosen message/);
    assert.match(prompt, /context.txt/);
    assert.match(prompt, /Older saved message/);
    assert.ok(prompt.includes(mode === 'task' ? 'Saved page' : f.task.humanId));
    assert.notEqual(workspacePoll(w, poll).messagesRevision, poll.messagesRevision);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE event_type='message.run_now'").get() as any).n, 1);
    assert.ok(w.messages.find(m => m.id === last.id)?.canRunNow);
    await assert.rejects(f.run(selected.id), { code: "message_not_pending" });
    assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  });
  test(`${mode}: Run now reserves before RPC; simultaneous run, edit, cancel and dispatcher cannot duplicate delivery`, async (t) => {
    const f = fixture(t, mode), m = await f.save();
    f.idle();
    let release!: () => void;
    f.gate(new Promise<void>(r => { release = r; }));
    const start = f.run(m.id);
    assert.equal(f.agents.workspace(mode, f.ownerId).messages[0]?.canRunNow, false);
    await assert.rejects(f.run(m.id), { code: "message_not_pending" });
    assert.throws(() => f.agents.cancelPendingMessage(mode, f.ownerId, m.id), { code: "message_not_pending" });
    assert.throws(() => f.agents.editPendingMessage(mode, f.ownerId, m.id, { message: "New", expectedVersion: 1 }), { code: "message_not_pending" });
    assert.equal(await Reflect.get(f.agents, "startSavedMessage").call(f.agents, m.id), false);
    release();
    await start;
    assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  });
  test(`${mode}: failed startup keeps message retryable and explicit retry bypasses backoff`, async (t) => {
    const f = fixture(t, mode), m = await f.save();
    f.idle();
    f.reject(true);
    await assert.rejects(f.run(m.id), { code: "message_start_failed" });
    const saved = f.agents.workspace(mode, f.ownerId).messages[0]!;
    assert.equal(saved.pending, true);
    assert.equal(saved.canRunNow, true);
    assert.ok((f.database.db.prepare("SELECT retry_after FROM pending_messages WHERE message_id=?").get(m.id) as any).retry_after);
    f.reject(false);
    await f.run(m.id);
    assert.equal(f.agents.workspace(mode, f.ownerId).messages[0]?.pending, false);
    assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 2);
  });
  test(`${mode}: active turns, stale ownership, system messages, cancellation and closed tasks cannot be bypassed`, async (t) => {
    const f = fixture(t, mode), m = await f.save();
    for (const state of ['running', 'waiting']) {
      f.database.db.prepare('UPDATE agent_sessions SET run_state=? WHERE owner_type=? AND owner_id=?').run(state, mode, f.ownerId);
      await assert.rejects(f.run(m.id), { code: 'session_running' });
    }
    f.idle();
    f.database.db.prepare("UPDATE agent_sessions SET active_turn_id='stale-active' WHERE owner_type=? AND owner_id=?").run(mode, f.ownerId);
    await assert.rejects(f.run(m.id), { code: 'session_running' });
    f.idle();
    await assert.rejects(f.agents.runPendingMessageNow('task', f.neighbor.id, m.id), { code: 'message_not_found' });
    await assert.rejects(f.run('missing'), { code: 'message_not_found' });
    f.database.db.prepare("UPDATE chat_messages SET role='system' WHERE id=?").run(m.id);
    await assert.rejects(f.run(m.id), { code: 'message_not_pending' });
    f.database.db.prepare("UPDATE chat_messages SET role='user' WHERE id=?").run(m.id);
    f.agents.cancelPendingMessage(mode, f.ownerId, m.id);
    await assert.rejects(f.run(m.id), { code: 'message_not_pending' });
    assert.deepEqual(f.requests, []);
    if (mode === 'task') {
      f.slots(0);
      const next = await f.save();
      f.database.db.prepare("UPDATE tasks SET status='closed',outcome='cancelled' WHERE id=?").run(f.task.id);
      assert.equal(f.agents.workspace(mode, f.ownerId).messages.at(-1)?.canRunNow, false);
      await assert.rejects(f.run(next.id), { code: 'message_not_pending' });
    }
  });
}
test('task Run now retains capacity, worktree and schedule guards; control chat stays available at zero worker slots', async (t) => {
  const f = fixture(t, 'task'), m = await f.save();
  f.idle();
  f.slots(0);
  await assert.rejects(f.run(m.id), { code: 'capacity_full' });
  f.slots(1);
  f.agents.workspace('task', f.neighbor.id);
  f.database.db.prepare("UPDATE agent_sessions SET run_state='waiting' WHERE owner_type='task' AND owner_id=?").run(f.neighbor.id);
  await assert.rejects(f.run(m.id), { code: 'project_conflict' });
  f.database.db.prepare("UPDATE agent_sessions SET run_state='idle' WHERE owner_type='task' AND owner_id=?").run(f.neighbor.id);
  f.database.db.prepare("UPDATE agent_sessions SET run_state='not_started' WHERE owner_type='task' AND owner_id=?").run(f.neighbor.id);
  f.agents.saveSchedule(f.neighbor.id, { expectedVersion: 0, localTime: '2099-11-01T10:00', timezone: 'UTC', policy: 'when_available' });
  // A pending task-start schedule cannot be overridden by direct message execution.
  f.database.db.prepare('UPDATE task_schedules SET task_id=? WHERE task_id=?').run(f.task.id, f.neighbor.id);
  await assert.rejects(f.run(m.id), { code: 'task_scheduled' });
  assert.deepEqual(f.requests, []);
  const control = fixture(t, 'orchestrator'), c = await control.save();
  control.idle();
  control.slots(0);
  await control.run(c.id);
  assert.equal(control.agents.workspace('orchestrator', 'main').messages[0]?.pending, false);
});
test('Run now does not execute future scheduled followups', async (t) => {
  const f = fixture(t, 'task');
  f.idle();
  f.agents.saveFollowup(f.task.id, 'future-message', { expectedVersion: 0, message: 'Future work', localTime: '2099-11-01T10:00', timezone: 'UTC', policy: 'when_available' });
  assert.equal(f.agents.workspace('task', f.task.id).messages[0]?.canRunNow, false);
  await assert.rejects(f.run('future-message'), { code: 'message_not_pending' });
  assert.deepEqual(f.requests, []);
});
test('Run now endpoints enforce authentication, origin, ownership and dispatch the existing message once', async (t) => {
  const f = fixture(t, 'task');
  f.agents.close();
  const stamp = new Date().toISOString();
  f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(stamp, stamp);
  const token = new AuthService(f.database, 365).createSession('test', '127.0.0.1', 'device').token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  t.mock.method(AgentService.prototype, 'capacity', () => ({ ...f.snapshot, availableSlots: 1 }));
  const actual = AgentService.prototype.runPendingMessageNow;
  const calls: string[] = [];
  t.mock.method(AgentService.prototype, 'runPendingMessageNow', async function (this: AgentService, type: SessionOwnerType, id: string, message: string) {
    const client = Reflect.get(this, 'codex');
    t.mock.method(client, 'initialize', async () => { });
    t.mock.method(client, 'request', async (method: string) => { calls.push(method); return method === 'thread/start' ? { thread: { id: 'api-thread' } } : method === 'turn/start' ? { turn: { id: 'api-turn' } } : {}; });
    return actual.call(this, type, id, message);
  });
  const app = await buildApp(f.config, f.database);
  try {
    for (const [base, type, id] of [[`/api/tasks/${f.task.humanId}`, 'task', f.task.id], ['/api/orchestrator', 'orchestrator', 'main']] as const) {
      const message = `api-${type}`;
      f.database.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,created_at) VALUES (?,?,?,'user','Saved request',?)").run(message, type, id, stamp);
      f.database.db.prepare('INSERT INTO pending_messages(message_id) VALUES (?)').run(message);
      const url = `${base}/messages/${message}/run-now`;
      assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
      assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://foreign.test' } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${f.neighbor.id}/messages/${message}/run-now`, headers })).statusCode, 404);
      const response = await app.inject({ method: 'POST', url, headers });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().workspace.messages.find((m: any) => m.id === message).pending, false);
      assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 409);
    }
    assert.equal(calls.filter(m => m === 'turn/start').length, 2);
  }
  finally {
    await app.close();
  }
});
test('Run now blocks overlapping roots registered as different projects', async (t) => {
  const f = fixture(t, 'task'), m = await f.save();
  f.idle();
  const project = f.tasks.createProject({ name: 'Alias project', prefix: 'ALS', rootDirectory: join(f.root, '.') }, 'user');
  const other = f.tasks.createTask({ projectId: project.id, title: 'Active elsewhere in the same root', status: 'in_progress' }, 'user');
  f.agents.workspace('task', other.id);
  f.database.db.prepare("UPDATE agent_sessions SET run_state='running' WHERE owner_type='task' AND owner_id=?").run(other.id);
  await assert.rejects(f.run(m.id), { code: 'project_conflict' });
  assert.deepEqual(f.requests, []);
  assert.equal(f.agents.workspace('task', f.ownerId).messages[0]?.pending, true);
});
test('Run-now reservation and audit storage roll back together before RPC', async (t) => {
  const f = fixture(t, 'task'), m = await f.save();
  f.idle();
  f.database.db.exec("CREATE TRIGGER reject_start BEFORE UPDATE OF starting_message_id ON agent_sessions BEGIN SELECT RAISE(ABORT, 'reservation unavailable'); END");
  await assert.rejects(f.run(m.id), /reservation unavailable/);
  assert.equal(f.agents.workspace('task', f.ownerId).session.runState, 'idle');
  assert.equal(f.agents.workspace('task', f.ownerId).messages[0]?.canRunNow, true);
  assert.equal((f.database.db.prepare("SELECT COUNT(*) AS count FROM session_events WHERE event_type='message.run_now'").get() as any).count, 0);
  assert.deepEqual(f.requests, []);
});
