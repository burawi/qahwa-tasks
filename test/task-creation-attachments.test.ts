import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentFromPlainText } from "../src/domain/types.js";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService, ATTACHMENT_LIMITS } from "../src/server/attachment-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskCreationService } from "../src/server/task-creation-service.js";
import { TaskService } from "../src/server/task-service.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-create-files-"));
  const config = { host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  for (const id of ["one", "two"]) database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES (?, ?, '', ?, ?)").run(id, id, new Date().toISOString(), new Date().toISOString());
  const project = tasks.createProject({ name: "Creation", prefix: "CRE", rootDirectory: root }, "user");
  const attachments = new AttachmentService(database);
  const creation = new TaskCreationService(database, tasks, attachments);
  const draftId = randomUUID();
  const input = { projectId: project.id, description: documentFromPlainText("Use the attached requirements"), status: "backlog" as const, draftId, attachmentIds: [] as string[] };
  return { root, config, database, tasks, project, attachments, creation, draftId, input,
    file(name = "notes.txt", content = Buffer.from("requirements"), draft = draftId, device = "one") {
      const uploaded = creation.initiate(draft, device, { filename: name, mediaType: name.endsWith("png") ? "image/png" : "text/plain", size: content.length });
      for (let offset = 0, chunk = 0; offset < content.length; offset += ATTACHMENT_LIMITS.chunkBytes, chunk++) attachments.appendChunk(uploaded.id, device, chunk, content.subarray(offset, offset + ATTACHMENT_LIMITS.chunkBytes));
      return attachments.complete(uploaded.id, device);
    },
    close() { attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("creation binds more than ten files atomically, survives restart/retention, and retries exactly once", async () => {
  const f = fixture();
  let reopened: AppDatabase | undefined;
  let retained: AttachmentService | undefined;
  try {
    const first = f.file(), image = f.file("screen.png", Buffer.from("image bytes"));
    const additional = Array.from({ length: 23 }, (_, i) => f.file(`reference-${i}.txt`, Buffer.from(`Reference ${i}`)));
    const discarded = f.file("discard.txt");
    const input = { ...f.input, attachmentIds: [first.id, image.id, ...additional.map(file => file.id)] };
    const created = f.creation.create(input, "one");
    assert.equal(created.status, "backlog");
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()!.n, 0);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM pending_messages").get()!.n, 0);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM scheduler_queue").get()!.n, 0);
    assert.equal(f.creation.create(input, "one").id, created.id, "A lost response is safe to retry");
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n, 1);
    assert.throws(() => f.creation.create({ ...input, description: documentFromPlainText("different") }, "one"), /different content/);
    assert.throws(() => f.creation.cancel(f.draftId, "one"), /already created/);
    assert.throws(() => f.attachments.remove(first.id, "one"), /history/);
    assert.throws(() => f.attachments.resolveDownload("task", `draft:${f.draftId}`, first.id), /expired/);
    assert.equal(existsSync(join(f.root, "attachments", discarded.id)), false, "Unselected uploads are swept");
    const message = f.database.db.prepare("SELECT metadata_json FROM chat_messages WHERE owner_id = ?").get(created.id)!;
    const stored = JSON.parse(String(message.metadata_json)).attachments;
    assert.deepEqual(stored.map((item: any) => item.id), input.attachmentIds);
    assert.ok(stored.every((item: any) => item.previewUrl.startsWith(`/api/tasks/${created.id}/`)));
    f.attachments.close();
    f.database.close();
    reopened = new AppDatabase(f.config);
    retained = new AttachmentService(reopened);
    retained.cleanupStale(Date.now() + 90 * 24 * 60 * 60 * 1000);
    assert.equal(retained.forTaskCreation(created.id).length, 25);
    additional.forEach((file, i) => assert.equal(readFileSync(retained!.resolveDownload("task", created.id, file.id).path, "utf8"), `Reference ${i}`));
    assert.equal(readFileSync(retained.resolveDownload("task", created.id, first.id).path, "utf8"), "requirements");
    assert.equal(new TaskCreationService(reopened, new TaskService(reopened), retained).create(input, "one").id, created.id);
  } finally { retained?.close(); reopened?.close(); f.close(); }
});

test("creation enforces draft/device scope, completeness, uniqueness, and limits without partial tasks", () => {
  const f = fixture();
  try {
    const own = f.file();
    const foreignDraft = f.file("foreign.txt", Buffer.from("x"), randomUUID());
    const foreignDevice = f.file("device.txt", Buffer.from("x"), randomUUID(), "two");
    const chatTask = f.tasks.createTask({ projectId: f.project.id, title: "Existing" }, "user");
    const chatFile = f.attachments.initiate("task", chatTask.id, "one", { filename: "chat", size: 0 });
    f.attachments.complete(chatFile.id, "one");
    const incomplete = f.creation.initiate(f.draftId, "one", { filename: "partial", size: 2 });
    const missing = randomUUID();
    for (const ids of [[foreignDraft.id], [foreignDevice.id], [chatFile.id], [missing], [incomplete.id], [own.id, own.id]]) {
      assert.throws(() => f.creation.create({ ...f.input, attachmentIds: ids }, "one"));
      assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n, 1);
    }
    assert.throws(() => f.creation.create({ ...f.input, attachmentIds: [own.id] }, "two"), /another device/);
    assert.throws(() => f.creation.create({ ...f.input, draftId: undefined, attachmentIds: [own.id] }, "one"), /draft is required/);
    assert.throws(() => f.creation.initiate(f.draftId, "one", { filename: "big", size: 100 * 1024 * 1024 + 1 }), /100 MiB/);
    const total = [own, f.file("two"), f.file("three")];
    f.database.db.prepare("UPDATE attachment_uploads SET declared_size = ? WHERE id IN (?, ?, ?)").run(100 * 1024 * 1024, ...total.map(item => item.id));
    assert.throws(() => f.creation.create({ ...f.input, attachmentIds: total.map(item => item.id) }, "one"), /250 MiB/);
    f.database.db.prepare("UPDATE attachment_uploads SET declared_size = ? WHERE id = ?").run(12, own.id);
    assert.throws(() => f.creation.create({ ...f.input, projectId: "missing", attachmentIds: [own.id] }, "one"), /project/);
    assert.equal(f.attachments.prepareForMessage("task", `draft:${f.draftId}`, "one", [own.id]).length, 1, "Failed creation leaves the draft usable");
    // A failure after inserting the task must roll back numbering, title jobs,
    // ownership and messages as well as the task itself.
    f.database.db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON task_creation_attachments BEGIN SELECT RAISE(ABORT, 'binding failed'); END");
    const nextNumber = f.database.db.prepare("SELECT next_task_number FROM projects WHERE id = ?").get(f.project.id);
    assert.throws(() => f.creation.create({ ...f.input, attachmentIds: [own.id] }, "one"), /binding failed/);
    assert.deepEqual(f.database.db.prepare("SELECT next_task_number FROM projects WHERE id = ?").get(f.project.id), nextNumber);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()!.n, 0);
    assert.equal(f.attachments.prepareForMessage("task", `draft:${f.draftId}`, "one", [own.id]).length, 1);
    f.database.db.exec("DROP TRIGGER fail_binding");
    f.creation.create({ ...f.input, attachmentIds: [own.id] }, "one");
  } finally { f.close(); }
});

test("cancelling a draft cleans completed/partial uploads and blocks delayed initiation", () => {
  const f = fixture();
  try {
    const complete = f.file();
    const partial = f.creation.initiate(f.draftId, "one", { filename: "partial", size: 100 });
    f.attachments.appendChunk(partial.id, "one", 0, Buffer.from("part"));
    assert.throws(() => f.creation.cancel(f.draftId, "two"), /another device/);
    f.creation.cancel(f.draftId, "one");
    f.creation.cancel(f.draftId, "one");
    for (const file of [complete, partial]) assert.equal(existsSync(join(f.root, "attachments", file.id)), false);
    assert.throws(() => f.attachments.complete(partial.id, "one"), /not found/);
    assert.throws(() => f.creation.initiate(f.draftId, "one", { filename: "late", size: 0 }), /no longer active/);
    assert.throws(() => f.creation.create(f.input, "one"), /cancelled/);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n, 0);
  } finally { f.close(); }
});

test("draft endpoints retain authentication and task-scoped download protection", async () => {
  const f = fixture();
  const app = await buildApp(f.config, f.database, { generateTitle: async () => "Attached requirements" });
  const token = new AuthService(f.database, 365).createSession("Test", "127.0.0.1", "one").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const url = `/api/task-drafts/${f.draftId}/attachments`;
  try {
    for (const route of [{ method: "POST" as const, url, payload: { filename: "zero", size: 0 } }, { method: "DELETE" as const, url: `/api/task-drafts/${f.draftId}` }, { method: "POST" as const, url: "/api/tasks", payload: f.input }]) assert.equal((await app.inject(route)).statusCode, 401);
    const start = await app.inject({ method: "POST", url, headers, payload: { filename: "empty.txt", size: 0 } });
    assert.equal(start.statusCode, 201, start.body);
    const id = start.json().attachment.id;
    assert.equal((await app.inject({ method: "POST", url: `/api/attachments/${id}/complete`, headers })).statusCode, 200);
    const input = { ...f.input, attachmentIds: [id] };
    const create = () => app.inject({ method: "POST", url: "/api/tasks", headers, payload: input });
    const first = await create(), retried = await create();
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(retried.json().task.id, first.json().task.id);
    const taskId = first.json().task.id;
    const preview = `/api/tasks/${taskId}/attachments/${id}`;
    assert.equal((await app.inject({ url: preview })).statusCode, 401);
    assert.equal((await app.inject({ url: preview, headers })).statusCode, 200);
    const other = f.tasks.createTask({ projectId: f.project.id, title: "Other" }, "user");
    assert.equal((await app.inject({ url: `/api/tasks/${other.id}/attachments/${id}`, headers })).statusCode, 410);
    const workspace = (await app.inject({ url: `/api/tasks/${taskId}/workspace`, headers })).json().workspace;
    assert.equal(workspace.messages[0].metadata.attachments[0].id, id);
    assert.equal(workspace.session.runState, "not_started");
    assert.equal((await app.inject({ method: "DELETE", url: `/api/task-drafts/${f.draftId}`, headers })).statusCode, 409);
    const cancelled = randomUUID();
    assert.equal((await app.inject({ method: "DELETE", url: `/api/task-drafts/${cancelled}`, headers })).statusCode, 204);
  } finally { await app.close(); f.close(); }
});

test("intake and a fresh implementation thread both receive saved files and native images", async () => {
  const f = fixture();
  const agents = new AgentService(f.database, f.tasks, f.attachments);
  const calls: Array<{ method: string; params: any }> = [];
  let sequence = 0;
  const fake = { initialize: async () => {}, close() {}, request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${++sequence}` } };
    if (method === "turn/start") return { turn: { id: `turn-${++sequence}` } };
    return {};
  } };
  Reflect.set(agents, "codex", fake);
  Reflect.set(agents, "resumeQueues", async () => {});
  try {
    const files = [f.file(), f.file("reference.png", Buffer.from("image"))];
    const task = f.creation.create({ ...f.input, attachmentIds: files.map(item => item.id) }, "one");
    const intake = await agents.triggerTask(task.id);
    assert.equal(intake.session.intakeState, "pending");
    assert.equal(calls.filter(call => call.method === "thread/start")[0]!.params.sandbox, "read-only");
    const complete = Reflect.get(agents, "handleCodexMessage").bind(agents);
    complete({ method: "item/completed", params: { threadId: intake.session.threadId, turnId: intake.session.activeTurnId, item: { id: "scope", type: "agentMessage", phase: "final_answer", text: 'Use both files. <!-- qahwa-intake:{"ready":true} -->' } } });
    complete({ method: "turn/completed", params: { threadId: intake.session.threadId, turn: { id: intake.session.activeTurnId, status: "completed" } } });
    // Exercise the actual application handoff without waiting for its scheduler.
    await Reflect.get(agents, "beginImplementation").call(agents, task.id);
    const turns = calls.filter(call => call.method === "turn/start");
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.match(turn.params.input[0].text, /notes.txt/);
      assert.match(turn.params.input[0].text, /reference.png/);
      assert.ok(turn.params.input.some((part: any) => part.type === "localImage" && existsSync(part.path)));
      assert.ok(turn.params.input[0].text.includes(join(f.root, "attachments", files[0]!.id, "data")));
    }
    assert.match(turns[1]!.params.input[0].text, /immutable task charter/);
    assert.notEqual(turns[0]!.params.threadId, turns[1]!.params.threadId);
    assert.equal(calls.filter(call => call.method === "thread/start")[1]!.params.sandbox, "danger-full-access");
  } finally { agents.close(); f.close(); }
});
