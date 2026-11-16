import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentService, recommendedParallelism, type CapacitySnapshot } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import { workspacePoll } from "../src/server/workspace-poll.js";

class ControlledAgents extends AgentService {
  limit = 0;
  override capacity(): CapacitySnapshot {
    const snapshot = super.capacity();
    const limit = this.limit ?? 0;
    return { ...snapshot, recommendedParallelism: limit, availableSlots: Math.max(0, limit - snapshot.activeTurns) };
  }
}

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-pending-"));
  const capture = join(root, "requests.jsonl");
  const control = join(root, "control.json");
  const settings = join(root, "settings.json");
  writeFileSync(settings, "{}");
  writeFileSync(capture, "");
  // No model calls: turns stay active until the test sends completion events.
  writeFileSync(join(root, "codex"), `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let sequence = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  if (request.id === undefined) return;
  const settings = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, "utf8"));
  if (request.method === "turn/start" && settings.reject) {
    send({ id: request.id, error: { message: "Temporary start failure" } }); return;
  }
  let result = {};
  if (request.method === "thread/start") result = { thread: { id: "thread-" + ++sequence } };
  if (request.method === "turn/start") result = { turn: { id: "turn-" + ++sequence } };
  setTimeout(() => send({ id: request.id, result }), request.method === "turn/start" ? settings.delay || 0 : 0);
});
setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(control)})) return;
  const events = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
  fs.unlinkSync(${JSON.stringify(control)});
  for (const event of events) send(event);
}, 5);
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  let database = new AppDatabase(config);
  let tasks = new TaskService(database);
  const timestamp = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
  let attachments = new AttachmentService(database, join(root, "temporary"));
  let agents = new ControlledAgents(database, tasks, attachments);
  const f = {
    root, config,
    get database() { return database; }, get tasks() { return tasks; },
    get attachments() { return attachments; }, get agents() { return agents; },
    task(prefix: string, projectId?: string) {
      const project = projectId ? { id: projectId } : tasks.createProject({ name: prefix, prefix, rootDirectory: root }, "user");
      return tasks.createTask({ projectId: project.id, title: `Work ${prefix}`, status: "todo" }, "user");
    },
    settings(value: { reject?: boolean; delay?: number }) { writeFileSync(settings, JSON.stringify(value)); },
    requests(): Array<{ method?: string; params: any }> {
      return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    turns() { return f.requests().filter((request) => request.method === "turn/start"); },
    async tick() { await Reflect.get(agents, "monitorPortfolio").call(agents); },
    async started(type: "task" | "orchestrator", id: string) {
      await until(() => Boolean(agents.workspace(type, id).session.activeTurnId), `Turn for ${type}/${id} did not start`);
    },
    async complete(type: "task" | "orchestrator", id: string, text = "<!-- qahwa-silent -->") {
      const { threadId, activeTurnId: turnId } = agents.workspace(type, id).session;
      assert.ok(turnId);
      writeFileSync(control, JSON.stringify([
        { method: "item/completed", params: { threadId, turnId, item: { id: `item-${turnId}`, type: "agentMessage", phase: "final_answer", text } } },
        { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
      ]));
      await until(() => agents.workspace(type, id).session.activeTurnId !== turnId, "Completion did not arrive");
    },
    restart() {
      agents.close(); attachments.close(); database.close();
      database = new AppDatabase(config); tasks = new TaskService(database);
      attachments = new AttachmentService(database, join(root, "temporary"));
      agents = new ControlledAgents(database, tasks, attachments);
    },
    close() {
      agents.close(); attachments.close(); database.close();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}

test("excerpt APIs scope sources to the chat and save exact rendered text with an authoritative role", async (t) => {
  const f = fixture();
  const snapshot = f.agents.capacity();
  t.mock.method(AgentService.prototype, "capacity", () => snapshot);
  const task = f.task("EXCRPT"), other = f.task("OTHER");
  const addSource = (type: string, id: string, sourceId: string) => {
    f.database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)")
      .run(sourceId, type, id, "A **formatted** source with `code`", new Date().toISOString());
  };
  addSource("task", task.id, "task-source");
  addSource("task", other.id, "other-source");
  addSource("orchestrator", "main", "control-source");
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const app = await buildApp(f.config, f.database);
  try {
    for (const [path, sourceId, foreignId] of [
      [`/api/tasks/${task.humanId}/messages`, "task-source", "other-source"],
      ["/api/orchestrator/messages", "control-source", "task-source"],
    ]) {
      for (const selectedExcerpt of [false, [], { messageId: sourceId, excerpt: "  " }, { messageId: sourceId, excerpt: "x".repeat(30_001) }, { messageId: 12, excerpt: "Text" }]) {
        const response = await app.inject({ method: "POST", url: path, headers, payload: { message: "Comment", selectedExcerpt } });
        assert.equal(response.statusCode, 400, response.body);
      }
      for (const messageId of [foreignId, "missing-source"]) {
        const response = await app.inject({ method: "POST", url: path, headers, payload: { message: "Comment", selectedExcerpt: { messageId, excerpt: "Text" } } });
        assert.equal(response.statusCode, 409, response.body);
      }
      const selectedExcerpt = { messageId: sourceId, excerpt: " formatted source\nwith code ", role: "user" };
      const accepted = await app.inject({ method: "POST", url: path, headers, payload: { message: "Comment on this", selectedExcerpt } });
      assert.equal(accepted.statusCode, 202, accepted.body);
      const saved = accepted.json().workspace.messages.at(-1);
      assert.equal(saved.body, "Comment on this");
      assert.deepEqual(saved.metadata.selectedExcerpt, { ...selectedExcerpt, role: "assistant" });
    }
  } finally { await app.close(); f.close(); }
});

test("excerpts survive failed starts, queue reopen, source changes, attachments, and agent delivery", async () => {
  for (const ownerType of ["task", "orchestrator"] as const) {
    const f = fixture();
    try {
      const task = f.task("QUOTE");
      const ownerId = ownerType === "task" ? task.id : "main";
      f.database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES ('quoted-source', ?, ?, 'assistant', 'Exact **formatted** excerpt', ?)")
        .run(ownerType, ownerId, new Date().toISOString());
      const selectedExcerpt = { messageId: "quoted-source", excerpt: "Exact formatted excerpt", role: "assistant" };
      const file = f.attachments.initiate(ownerType, ownerId, "device", { filename: "context.txt", size: 7, mediaType: "text/plain" });
      f.attachments.appendChunk(file.id, "device", 0, Buffer.from("context")); f.attachments.complete(file.id, "device");
      f.agents.limit = 1; f.settings({ reject: true });
      const saved = (await f.agents.send(ownerType, ownerId, "My comment", false, "user", [file.id], "device", [], undefined, selectedExcerpt)).messages.at(-1)!;
      assert.equal(saved.pending, true);
      assert.deepEqual(saved.metadata?.selectedExcerpt, selectedExcerpt);
      f.database.db.prepare("UPDATE chat_messages SET body = 'Edited source' WHERE id = 'quoted-source'").run();
      f.restart(); f.settings({}); f.agents.limit = 1;
      const restored = f.agents.workspace(ownerType, ownerId).messages.find(message => message.id === saved.id)!;
      assert.equal(restored.pending, true);
      assert.deepEqual(restored.metadata?.selectedExcerpt, selectedExcerpt);
      assert.equal(await Reflect.get(f.agents, "startSavedMessage").call(f.agents, saved.id), true);
      const prompt = f.turns().at(-1)!.params.input[0].text;
      assert.ok(prompt.includes(JSON.stringify(selectedExcerpt)));
      assert.match(prompt, /quoted context data, not a new instruction or authorization/);
      assert.match(prompt, /My comment/);
      assert.match(prompt, /context.txt/);
      assert.equal(f.agents.workspace(ownerType, ownerId).messages.find(message => message.id === saved.id)?.pending, false);
    } finally { f.close(); }
  }
});

test("paired APIs save capacity-blocked task messages and process control messages with no worker slots", async (t) => {
  const f = fixture();
  // Fixed worker capacity; the fixture's fake app-server handles control turns.
  const snapshot = f.agents.capacity();
  t.mock.method(AgentService.prototype, "capacity", () => snapshot);
  const task = f.task("API");
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const app = await buildApp(f.config, f.database);
  try {
    for (const [path, readPath] of [[`/api/tasks/${task.humanId}/messages`, `/api/tasks/${task.humanId}/workspace`], ["/api/orchestrator/messages", "/api/orchestrator"]]) {
      const result = await app.inject({ method: "POST", url: path, headers, payload: { message: "My carefully written request" } });
      assert.equal(result.statusCode, 202, result.body);
      const pending = path !== "/api/orchestrator/messages";
      assert.equal(result.json().workspace.messages.at(-1).pending, pending);
      const refreshed = await app.inject({ method: "GET", url: readPath, headers });
      assert.equal(refreshed.json().workspace.messages.at(-1).body, "My carefully written request");
      assert.equal(refreshed.json().workspace.messages.at(-1).pending, pending);
    }
    assert.equal(f.turns().length, 1);
    const queued = await app.inject({ method: "POST", url: "/api/orchestrator/messages", headers, payload: { message: "Next control message" } });
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().workspace.messages.at(-1).pending, true);
    assert.equal(f.turns().length, 1);
  } finally { await app.close(); f.close(); }
});

test("queued text and attachment-only messages survive reopen, expiry, and temporary-file loss", async () => {
  const f = fixture();
  try {
    const task = f.task("DUR");
    const text = "A long considered request.\n".repeat(900);
    await f.agents.send("task", task.id, text);
    await f.agents.send("orchestrator", "main", "Active control turn");
    const ids: string[] = [];
    for (const [type, id] of [["task", task.id], ["orchestrator", "main"]] as const) {
      const file = f.attachments.initiate(type, id, "device", { filename: "context.txt", size: 7, mediaType: "text/plain" });
      f.attachments.appendChunk(file.id, "device", 0, Buffer.from("context"));
      f.attachments.complete(file.id, "device");
      await f.agents.send(type, id, "", false, "user", [file.id], "device");
      ids.push(file.id);
    }
    f.database.db.prepare("UPDATE attachment_uploads SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal(f.attachments.cleanupStale(), 0);
    rmSync(join(f.root, "temporary"), { recursive: true, force: true });
    f.settings({ delay: 150 });
    f.restart();
    assert.equal(f.agents.workspace("task", task.id).messages[0]?.body, text.trim());
    assert.deepEqual(f.agents.workspace("task", task.id).messages.map((message) => message.pending), [true, true]);
    for (const [index, type, id] of [[0, "task", task.id], [1, "orchestrator", "main"]] as const) {
      const saved = f.attachments.resolveDownload(type, id, ids[index]!);
      assert.equal(readFileSync(saved.path, "utf8"), "context");
      assert.ok(saved.path.startsWith(join(f.root, "pending-attachments")));
    }
    await f.started("orchestrator", "main");
    assert.equal(f.agents.capacity().availableSlots, 0);
    assert.equal(f.agents.capacity().recommendedParallelism, 0);
    const prompt = f.turns().at(-1)!.params.input[0].text;
    assert.ok(prompt.includes(ids[1]!));
    assert.equal(f.agents.workspace("orchestrator", "main").messages.find((m) => m.body === "")?.pending, false);
    assert.equal(f.agents.workspace("task", task.id).messages[1]?.pending, true);
  } finally { f.close(); }
});

test("orchestrator goes first and chooses task delivery order without additional work authorization", async () => {
  const f = fixture();
  try {
    const first = f.task("ONE"), second = f.task("TWO");
    const a = (await f.agents.send("task", first.id, "First request")).messages[0]!;
    const b = (await f.agents.send("task", second.id, "Second request")).messages[0]!;
    await f.agents.send("orchestrator", "main", "Review these priorities");
    f.agents.limit = 1;
    await f.tick(); await f.started("orchestrator", "main");
    assert.equal(f.turns().length, 1);
    assert.match(f.turns()[0]!.params.input[0].text, /Review these priorities/);
    await f.complete("orchestrator", "main", `<!-- qahwa-actions:${JSON.stringify([{ type: "dispatch", messageIds: [b.id, "missing-id", a.id] }])} --><!-- qahwa-silent -->`);
    await f.started("task", second.id);
    assert.equal(f.agents.capacity().activeTurns, 1);
    assert.equal(f.agents.workspace("task", first.id).messages[0]?.pending, true);
    assert.equal(f.agents.workspace("task", second.id).messages[0]?.pending, false);
    await f.complete("task", second.id); await f.started("task", first.id);
    assert.equal(f.agents.capacity().activeTurns, 1);
    assert.match(f.turns()[2]!.params.input[0].text, /First request/);
    await f.complete("task", first.id);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM pending_messages").get().n, 0);
  } finally { f.close(); }
});

test("task-only backlog wakes the orchestrator to schedule; per-chat FIFO and worktree limits hold", async () => {
  const f = fixture();
  try {
    const first = f.task("FIFO"), neighbor = f.task("FIFO", first.projectId);
    for (const task of [first, neighbor]) {
      f.agents.workspace("task", task.id);
      f.database.db.prepare("UPDATE agent_sessions SET intake_state='ready' WHERE owner_id=?").run(task.id);
    }
    f.agents.limit = 2;
    await f.agents.send("task", first.id, "Active turn");
    const next = (await f.agents.send("task", first.id, "Next turn")).messages.at(-1)!;
    const last = (await f.agents.send("task", first.id, "Last turn")).messages.at(-1)!;
    const other = (await f.agents.send("task", neighbor.id, "Same worktree")).messages[0]!;
    assert.equal(f.turns().length, 1);
    await f.complete("task", first.id); await f.started("orchestrator", "main");
    assert.match(f.turns()[1]!.params.input[0].text, /Schedule the saved pending task messages/);
    assert.match(f.turns()[1]!.params.input[0].text, /"eligibleAfterThisTurn":true/);
    assert.ok(!f.agents.workspace("orchestrator", "main").messages.some((message) => message.metadata?.queueScheduling));
    await f.complete("orchestrator", "main", `<!-- qahwa-actions:${JSON.stringify([{ type: "dispatch", messageIds: [last.id, next.id, other.id] }])} --><!-- qahwa-silent -->`);
    await f.started("task", first.id);
    assert.equal(f.agents.capacity().activeTurns, 1);
    assert.match(f.turns()[2]!.params.input[0].text, /Conversation input: Next turn/);
    assert.equal(f.agents.workspace("task", first.id).messages.find((m) => m.id === last.id)?.pending, true);
    await f.complete("task", first.id); await f.started("task", first.id);
    assert.match(f.turns()[3]!.params.input[0].text, /Conversation input: Last turn/);
    await f.complete("task", first.id); await f.started("task", neighbor.id);
    assert.match(f.turns()[4]!.params.input[0].text, /Same worktree/);
  } finally { f.close(); }
});

test("start failures keep one saved message, back off, and clear Pending only after turn acknowledgement", async () => {
  const f = fixture();
  try {
    f.agents.limit = 0; f.settings({ reject: true });
    const accepted = await f.agents.send("orchestrator", "main", "Keep my message");
    assert.equal(accepted.messages[0]?.pending, true);
    assert.equal(accepted.session.runState, "failed");
    await f.agents.send("orchestrator", "main", "A later control message");
    await f.tick(); assert.equal(f.turns().length, 1);
    f.settings({ delay: 150 });
    f.database.db.prepare("UPDATE pending_messages SET retry_after = NULL").run();
    const retry = f.tick();
    await until(() => f.turns().length === 2, "Retry did not reach app server");
    const pending = f.agents.workspace("orchestrator", "main");
    assert.equal(pending.messages[0]?.pending, true);
    await retry;
    const started = f.agents.workspace("orchestrator", "main");
    assert.equal(started.messages.length, 2);
    assert.equal(started.messages[0]?.pending, false);
    assert.equal(started.messages[1]?.pending, true);
    assert.notEqual(workspacePoll(started, {}).messagesRevision, workspacePoll(pending, {}).messagesRevision);
    await f.complete("orchestrator", "main"); await f.started("orchestrator", "main");
    assert.match(f.turns().at(-1)!.params.input[0].text, /Conversation input: A later control message/);
  } finally { f.close(); }
});

test("simultaneous control submissions serialize even with no worker slots", async () => {
  const f = fixture();
  try {
    f.agents.limit = 0;
    const first = f.agents.send("orchestrator", "main", "First");
    const second = f.agents.send("orchestrator", "main", "Second");
    const third = f.agents.send("orchestrator", "main", "Third");
    await Promise.all([first, second, third]);
    assert.equal(f.turns().length, 1);
    assert.deepEqual(f.agents.workspace("orchestrator", "main").messages.map((m) => m.pending), [false, true, true]);
    await f.complete("orchestrator", "main"); await f.started("orchestrator", "main");
    assert.match(f.turns()[1]!.params.input[0].text, /Conversation input: Second/);
    await f.complete("orchestrator", "main"); await f.started("orchestrator", "main");
    assert.match(f.turns()[2]!.params.input[0].text, /Conversation input: Third/);
    assert.equal(f.agents.workspace("orchestrator", "main").messages.filter((m) => m.role === "user").length, 3);
  } finally { f.close(); }
});

test("an unread orchestrator message cannot authorize actions from an earlier active turn", async () => {
  const f = fixture();
  try {
    const task = f.task("AUTH"); f.agents.limit = 1;
    await f.agents.send("orchestrator", "main", "Give me a status update");
    await f.agents.send("orchestrator", "main", "Start the new task");
    await f.complete("orchestrator", "main", `<!-- qahwa-actions:${JSON.stringify([{ type: "start", taskId: task.humanId, authorization: "Start the new task" }])} -->`);
    await f.started("orchestrator", "main");
    assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(task.id), undefined);
    assert.ok(f.agents.workspace("orchestrator", "main").messages.some((m) => m.body.includes("was not authorized")));
    assert.equal(f.agents.workspace("task", task.id).messages.length, 0);
  } finally { f.close(); }
});

test("queued intake replies keep the implementation handoff and do not read later pending messages", async () => {
  const f = fixture();
  try {
    const task = f.task("INTAKE"); f.agents.limit = 1;
    await f.agents.triggerTask(task.id);
    const intakeThread = f.agents.workspace("task", task.id).session.threadId;
    const reply = (await f.agents.send("task", task.id, "Use the agreed acceptance criteria")).messages.at(-1)!;
    const later = (await f.agents.send("task", task.id, "A later separate instruction")).messages.at(-1)!;
    await f.complete("task", task.id, 'Scope agreed. <!-- qahwa-intake:{"ready":true} -->');
    await f.started("orchestrator", "main");
    await f.complete("orchestrator", "main", `<!-- qahwa-actions:${JSON.stringify([{ type: "dispatch", messageIds: [reply.id, later.id] }])} --><!-- qahwa-silent -->`);
    await f.started("task", task.id);
    assert.notEqual(f.agents.workspace("task", task.id).session.threadId, intakeThread);
    const turn = f.turns().at(-1)!;
    assert.match(turn.params.input[0].text, /Begin implementation from this exact, immutable task charter/);
    assert.match(turn.params.input[0].text, /Use the agreed acceptance criteria/);
    assert.doesNotMatch(turn.params.input[0].text, /A later separate instruction/);
    assert.equal(f.agents.workspace("task", task.id).messages.find((m) => m.id === later.id)?.pending, true);
    assert.equal(f.requests().filter((request) => request.method === "thread/start").at(-1)!.params.sandbox, "danger-full-access");
    assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(task.id), undefined);
  } finally { f.close(); }
});

test("control turns run above reduced worker estimates while task scheduling stays within capacity", async () => {
  const f = fixture();
  try {
    const first = f.task("BUSY"), second = f.task("ALSO"), queued = f.task("LATER");
    f.agents.limit = 2;
    await f.agents.send("task", first.id, "Existing worker one");
    await f.agents.send("task", second.id, "Existing worker two");
    assert.equal(f.agents.capacity().availableSlots, 0);
    await f.agents.send("orchestrator", "main", "Respond with both worker slots full");
    await f.started("orchestrator", "main");
    assert.equal(f.agents.capacity().activeTurns, 3);
    await f.complete("orchestrator", "main");

    // Simulate CPU/load and memory estimates reducing safe parallelism below
    // already running work. That estimate must only constrain new task work.
    f.agents.limit = recommendedParallelism(12, 1024 ** 3, 16 * 1024 ** 3, 12);
    assert.equal(f.agents.limit, 1);
    const pending = (await f.agents.send("task", queued.id, "Wait for safe task capacity")).messages[0]!;
    await assert.rejects(() => f.agents.triggerTask(queued.id), { code: "capacity_full" });
    const control = await f.agents.send("orchestrator", "main", "Keep the control chat responsive under pressure");
    assert.equal(control.messages.at(-1)?.pending, false);
    assert.equal(control.session.runState, "running");
    assert.equal(f.agents.capacity().activeTurns, 3);
    assert.equal(f.agents.workspace("task", queued.id).messages[0]?.pending, true);
    await f.complete("orchestrator", "main", `<!-- qahwa-actions:${JSON.stringify([{ type: "dispatch", messageIds: [pending.id] }])} --><!-- qahwa-silent -->`);
    assert.equal(f.agents.workspace("task", queued.id).session.activeTurnId, null);
    await f.complete("task", first.id);
    assert.equal(f.agents.capacity().availableSlots, 0);
    assert.equal(f.agents.workspace("task", queued.id).session.activeTurnId, null);
    await f.complete("task", second.id);
    await f.started("task", queued.id);
    assert.equal(f.agents.capacity().activeTurns, 1);
  } finally { f.close(); }
});

test("an in-flight task dispatch does not lock out user control messages", async () => {
  const f = fixture();
  try {
    const task = f.task("START");
    const pending = (await f.agents.send("task", task.id, "Dispatch this task")).messages[0]!;
    await f.agents.send("orchestrator", "main", "Schedule this accepted message");
    await f.complete("orchestrator", "main", `<!-- qahwa-actions:${JSON.stringify([{ type: "dispatch", messageIds: [pending.id] }])} --><!-- qahwa-silent -->`);
    f.settings({ delay: 150 }); f.agents.limit = 1;
    const dispatch = f.tick();
    await until(() => f.turns().length === 2, "Task dispatch did not reach the app server");
    assert.equal(Reflect.get(f.agents, "drainingMessages"), true);
    assert.equal(f.agents.capacity().availableSlots, 0);
    const control = f.agents.send("orchestrator", "main", "Respond during task startup");
    await until(() => f.turns().length === 3, "Control chat was blocked by the task's drain lock");
    await Promise.all([dispatch, control]);
    assert.equal(f.agents.workspace("orchestrator", "main").messages.at(-1)?.pending, false);
    assert.equal(f.agents.capacity().activeTurns, 2);
  } finally { f.close(); }
});

test("control messages with attachments stay pending while the orchestrator waits and run afterward without capacity", async () => {
  const f = fixture();
  try {
    await f.agents.send("orchestrator", "main", "An active control turn");
    f.database.db.prepare("UPDATE agent_sessions SET run_state = 'waiting' WHERE owner_type = 'orchestrator'").run();
    const file = f.attachments.initiate("orchestrator", "main", "device", { filename: "context.txt", size: 7, mediaType: "text/plain" });
    f.attachments.appendChunk(file.id, "device", 0, Buffer.from("context"));
    f.attachments.complete(file.id, "device");
    const accepted = await f.agents.send("orchestrator", "main", "", false, "user", [file.id], "device");
    assert.equal(accepted.messages.at(-1)?.pending, true);
    assert.equal(f.turns().length, 1);
    await f.complete("orchestrator", "main");
    await f.started("orchestrator", "main");
    assert.ok(f.turns().at(-1)!.params.input[0].text.includes(file.id));
    assert.equal(f.agents.workspace("orchestrator", "main").messages.at(-1)?.pending, false);
    assert.equal(f.agents.capacity().availableSlots, 0);
  } finally { f.close(); }
});

test("user messages bypass pending automatic observations without granting those observations a capacity exemption", async () => {
  const f = fixture();
  try {
    const automatic = await f.agents.send("orchestrator", "main", "Automatic observation", false, "system");
    assert.equal(automatic.messages[0]?.pending, true);
    assert.equal(f.turns().length, 0);
    await f.agents.send("orchestrator", "main", "Respond to the user first");
    await f.started("orchestrator", "main");
    assert.equal(f.turns().length, 1);
    assert.match(f.turns()[0]!.params.input[0].text, /Conversation input: Respond to the user first/);
    assert.equal(f.agents.workspace("orchestrator", "main").messages[0]?.pending, true);
    await f.complete("orchestrator", "main");
    assert.equal(f.turns().length, 1);
    f.agents.limit = 1; await f.tick(); await f.started("orchestrator", "main");
    assert.match(f.turns()[1]!.params.input[0].text, /Conversation input: Automatic observation/);
  } finally { f.close(); }
});
