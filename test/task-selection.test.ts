import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import { readTaskSelection, taskSelectionKey, toggleTaskSelection, writeTaskSelection } from "../src/web/task-selection.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-selection-"));
  const capture = join(root, "requests.jsonl"), settings = join(root, "settings.json");
  writeFileSync(capture, ""); writeFileSync(settings, "{}");
  // Real app-server transport, with no model calls. Turns stay active until recovery.
  writeFileSync(join(root, "codex"), `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
let sequence = 0;
readline.createInterface({input: process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  if (request.id === undefined) return;
  if (request.method === "turn/start" && JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, "utf8")).reject) {
    process.stdout.write(JSON.stringify({id: request.id, error: {message: "Temporary start failure"}}) + "\\n"); return;
  }
  const result = request.method === "thread/start" ? {thread: {id: "thread-" + ++sequence}}
    : request.method === "turn/start" ? {turn: {id: "turn-" + ++sequence}} : {};
  process.stdout.write(JSON.stringify({id: request.id, result}) + "\\n");
});
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  let database = new AppDatabase(config), tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Selection", prefix: "SEL", rootDirectory: root }, "user");
  const first = tasks.createTask({ projectId: project.id, title: "Original title" }, "user");
  const second = tasks.createTask({ projectId: project.id, title: "Second title" }, "user");
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', 'now', 'now')").run();
  let attachments = new AttachmentService(database, join(root, "temporary"));
  let agents = new AgentService(database, tasks, attachments);
  const f = {
    config, first, second,
    get database() { return database; }, get tasks() { return tasks; }, get agents() { return agents; }, get attachments() { return attachments; },
    reject(value: boolean) { writeFileSync(settings, JSON.stringify({ reject: value })); },
    prompts(): string[] { return readFileSync(capture, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(r => r.method === "turn/start").map(r => r.params.input[0].text); },
    restart() {
      agents.close(); attachments.close(); database.close();
      database = new AppDatabase(config); tasks = new TaskService(database);
      attachments = new AttachmentService(database, join(root, "temporary")); agents = new AgentService(database, tasks, attachments);
    },
    close() {
      agents.close(); attachments.close(); database.close();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}

test("orchestrator API validates selection and saves canonical server titles with attachments", async () => {
  const f = fixture();
  const app = await buildApp(f.config, f.database);
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const post = (selectedTaskIds: unknown) => app.inject({ method: "POST", url: "/api/orchestrator/messages", headers, payload: { message: "Explain the selected tasks", selectedTaskIds } });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/orchestrator/messages", payload: { message: "Selected", selectedTaskIds: [] } })).statusCode, 401);
    for (const invalid of [null, "SEL-0001", [42], [""], Array(1001).fill(f.first.id)]) assert.equal((await post(invalid)).statusCode, 400);
    assert.equal((await post(["missing"])).statusCode, 404);
    assert.equal(f.agents.workspace("orchestrator", "main").messages.length, 0);
    const upload = await app.inject({ method: "POST", url: "/api/orchestrator/attachments", headers, payload: { filename: "context.txt", mediaType: "text/plain", size: 7 } });
    assert.equal(upload.statusCode, 201);
    const file = upload.json().attachment;
    assert.equal((await app.inject({ method: "PUT", url: `/api/attachments/${file.id}/chunks/0`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("context") })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/api/attachments/${file.id}/complete`, headers })).statusCode, 200);
    const response = await app.inject({ method: "POST", url: "/api/orchestrator/messages", headers, payload: { message: "Explain the selected tasks", selectedTaskIds: [f.first.id, f.first.humanId, f.second.humanId], attachmentIds: [file.id], selectedTasks: [{ title: "Forged title" }] } });
    assert.equal(response.statusCode, 202, response.body);
    const saved = response.json().workspace.messages.at(-1);
    assert.deepEqual(saved.metadata.selectedTasks, [f.first, f.second].map(({ id, humanId, title }) => ({ id, humanId, title })));
    assert.equal(saved.metadata.attachments[0].id, file.id);
    assert.equal(saved.body, "Explain the selected tasks");
    const prompt = f.prompts()[0]!;
    assert.match(prompt, /Selected tasks for this message \(saved at submission\):/);
    assert.match(prompt, /Selection alone grants no authority/);
    assert.ok(!prompt.includes("Forged title"));
    const loaded = await app.inject({ method: "GET", url: "/api/orchestrator", headers });
    assert.deepEqual(loaded.json().workspace.messages.at(-1).metadata.selectedTasks, saved.metadata.selectedTasks);
  } finally { await app.close(); f.close(); }
});

test("queued snapshots survive later selections, title edits, restart and failed-turn retries", async () => {
  const f = fixture();
  const reference = ({ id, humanId, title }: typeof f.first) => ({ id, humanId, title });
  const snapshot = (prompt: string) => JSON.parse(prompt.split("Selected tasks for this message (saved at submission): ")[1]!.split(". Resolve")[0]!);
  try {
    await f.agents.send("orchestrator", "main", "Active turn");
    await f.agents.send("orchestrator", "main", "Explain the selected tasks", false, "user", [], undefined, [f.first.id]);
    await f.agents.send("orchestrator", "main", "And these selected tasks", false, "user", [], undefined, [f.second.id]);
    await f.agents.send("orchestrator", "main", "Selection was cleared", false, "user", [], undefined, []);
    assert.equal(f.prompts().length, 1, "Busy control chat queues follow-ups");
    f.tasks.updateTask(f.first.id, { title: "Renamed after submission", expectedVersion: f.first.version }, "user");
    const pending = () => f.agents.workspace("orchestrator", "main").messages.filter(m => m.pending);
    const originalMessages = pending();
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition()) { assert.ok(Date.now() < deadline, "Recovery did not finish"); await new Promise(resolve => setTimeout(resolve, 5)); }
    };
    f.reject(true); f.restart();
    assert.deepEqual(pending(), originalMessages);
    await until(() => f.agents.workspace("orchestrator", "main").session.runState === "failed");
    assert.deepEqual(pending(), originalMessages, "Failed start leaves body and metadata intact");
    assert.deepEqual(snapshot(f.prompts().at(-1)!), [reference(f.first)]);
    f.reject(false); f.restart();
    // A normal restart respects the saved retry delay; expire it only in this fixture.
    f.database.db.prepare("UPDATE pending_messages SET retry_after = NULL").run();
    await Reflect.get(f.agents, "monitorPortfolio").call(f.agents);
    await until(() => pending().length === 2);
    assert.deepEqual(snapshot(f.prompts().at(-1)!), [reference(f.first)]);
    assert.equal(pending().length, 2);
    f.restart();
    await until(() => pending().length === 1);
    assert.deepEqual(snapshot(f.prompts().at(-1)!), [reference(f.second)]);
    f.restart();
    await until(() => pending().length === 0);
    assert.deepEqual(snapshot(f.prompts().at(-1)!), [], "Empty selection replaces old context");
    assert.deepEqual(f.agents.workspace("orchestrator", "main").messages.slice(1).map(m => m.metadata?.selectedTasks), [[reference(f.first)], [reference(f.second)], []]);
    assert.equal(f.tasks.getTask(f.first.id).status, "backlog", "Selection alone never starts tasks");
    f.restart();
    await f.agents.send("orchestrator", "main", "Automated observation", false, "system");
    assert.match(f.prompts().at(-1)!, /automated message has no user selection snapshot/);
  } finally { f.close(); }
});

test("browser selection persists scoped identities, tolerates unavailable storage, and toggles immutably", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const task = { id: "one", humanId: "SEL-0001", title: "One" };
  const key = taskSelectionKey("server", "device");
  const selected = toggleTaskSelection([], task);
  writeTaskSelection(key, selected, storage);
  assert.deepEqual(readTaskSelection(key, storage), [task]);
  assert.deepEqual(readTaskSelection(taskSelectionKey("another", "device"), storage), []);
  assert.deepEqual(readTaskSelection(taskSelectionKey("server", "other device"), storage), []);
  assert.deepEqual(toggleTaskSelection(selected, task), []);
  assert.equal(selected.length, 1);
  values.set(key, JSON.stringify([task, task, null, { id: 3 }]));
  assert.deepEqual(readTaskSelection(key, storage), [task]);
  values.set(key, "broken"); assert.deepEqual(readTaskSelection(key, storage), []);
  const blocked = { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Full"); } };
  assert.deepEqual(readTaskSelection(key, blocked), []);
  assert.doesNotThrow(() => writeTaskSelection(key, selected, blocked));
});
