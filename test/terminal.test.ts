import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { TerminalService } from "../src/server/terminal-service.js";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-terminal-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const config = { host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 1 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Shell", prefix: "SH", rootDirectory: projectRoot }, "user");
  const now = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(now, now);
  return { root, projectRoot, config, database, tasks, project };
}
async function until(check: () => Promise<boolean> | boolean) {
  const end = Date.now() + 6000;
  while (!await check()) {
    assert.ok(Date.now() < end, "Terminal condition did not arrive");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("real PTY starts in selected directory, streams, accepts prompts and deduplicates input", async () => {
  const f = fixture();
  const service = new TerminalService(f.database, f.tasks);
  try {
    const key = randomUUID();
    const created = await service.create(f.project.id, key, "device");
    assert.equal(created.task.sessionKind, "terminal");
    assert.equal((await service.create(f.project.id, key, "device")).task.id, created.task.id);
    assert.equal(f.tasks.listTasks({ tab: "active" }).length, 1);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()!.n, 0);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM task_title_jobs").get()!.n, 0);
    const id = created.task.id, generation = created.terminal.generation;
    const send = (data: string, inputId = randomUUID()) => service.input(id, { generation, inputId, data });
    send("pwd\r");
    await until(async () => (await service.read(id)).data.includes(f.projectRoot));
    send("export QAH_KEEP=alive; cd ..\r");
    send("printf '%s:%s\\n' \"$QAH_KEEP\" \"$PWD\"\r");
    await until(async () => (await service.read(id)).data.includes(`alive:${f.root}`));
    const snapshot = await service.read(id);
    const waiting = service.read(id, snapshot.generation, snapshot.cursor, true);
    send("printf 'stream-one\\n'; sleep 0.15; printf 'stream-two\\n'\r");
    assert.equal((await waiting).reset, false);
    await until(async () => /(?:^|\n)stream-two(?:\n|$)/.test((await service.read(id)).screenText));
    const inputId = randomUUID();
    send("printf x >> dedupe\r", inputId); send("printf x >> dedupe\r", inputId);
    await until(() => { try { return readFileSync(join(f.root, "dedupe"), "utf8") === "x"; } catch { return false; } });
    send("printf y >> dedupe\r", inputId); // Reused retry keys never execute a second payload.
    assert.throws(() => service.input(id, { generation: "old", inputId: randomUUID(), data: "oops\r" }), /Shell changed/);
    send("read -r -p 'Your name: ' QAH_NAME; printf 'HELLO:%s\\n' \"$QAH_NAME\"\r");
    await until(async () => (await service.read(id)).data.includes("Your name: "));
    send("قهوة\r");
    await until(async () => (await service.read(id)).data.includes("HELLO:قهوة"));
    assert.equal(readFileSync(join(f.root, "dedupe"), "utf8"), "x");
    send("read -rs -p 'Password: ' QAH_SECRET; unset QAH_SECRET; printf '\\nSECRET_DONE\\n'\r");
    await until(async () => ((await service.read(id)).data.match(/Password:/g)?.length ?? 0) >= 2);
    send("hidden-passphrase\r");
    await until(async () => /(?:^|\n)SECRET_DONE(?:\n|$)/.test((await service.read(id)).screenText));
    assert.ok(!(await service.read(id)).data.includes("hidden-passphrase"), "Hidden prompt input must not enter saved history");
    assert.deepEqual((f.database.db.prepare("PRAGMA table_info(terminal_input_receipts)").all() as Array<{ name: string }>).map(row => row.name), ["task_id", "generation", "input_id"]);
    assert.throws(() => f.tasks.deleteBacklogTask(id, "user"), /Exit the running shell/);
  } finally { await service.close(); f.database.close(); }
});

test("fullscreen screen survives reconnect; resize, interrupt, exit and fresh shell work", async () => {
  const f = fixture(); const service = new TerminalService(f.database, f.tasks);
  try {
    const { task, terminal } = await service.create(f.project.id, randomUUID(), "device");
    const send = (data: string) => service.input(task.id, { generation: terminal.generation, inputId: randomUUID(), data });
    await service.resize(task.id, { generation: terminal.generation, cols: 92, rows: 31 });
    send("stty size\r");
    await until(async () => (await service.read(task.id)).data.includes("31 92"));
    send("printf '\\033[?1049h\\033[2J\\033[HFULL_SCREEN'; read -r QAH_REPLY; printf '\\033[?1049lANSWER:%s\\n' \"$QAH_REPLY\"\r");
    await until(async () => (await service.read(task.id)).data.includes("\x1b[?1049h"));
    const reopened = await service.read(task.humanId);
    assert.ok(reopened.data.includes("FULL_SCREEN"));
    assert.equal(reopened.cols, 92); assert.equal(reopened.rows, 31);
    send("yes\r");
    await until(async () => (await service.read(task.id)).data.includes("ANSWER:yes"));
    send("sleep 60\r"); send("\x03"); send("printf 'AFTER_INTERRUPT\\n'\r");
    await until(async () => /(?:^|\n)AFTER_INTERRUPT(?:\n|$)/.test((await service.read(task.id)).screenText));
    send("exit 7\r");
    await until(async () => (await service.read(task.id)).state === "exited");
    assert.equal((await service.read(task.id)).exitCode, 7);
    await service.start(task.id);
    const next = await service.read(task.id);
    assert.notEqual(next.generation, terminal.generation);
    assert.equal(next.state, "running");
    assert.ok(next.data.includes("ANSWER:yes"), "Previous history remains after starting a new shell");
    await assert.rejects(service.resize(task.id, { generation: next.generation, cols: 10000, rows: 10 }), /dimensions/);
  } finally { await service.close(); f.database.close(); }
});

test("saved screen remains after backend restart, marked interrupted and never silently reexecutes", async () => {
  const f = fixture(); let service = new TerminalService(f.database, f.tasks);
  try {
    const { task, terminal } = await service.create(f.project.id, randomUUID(), "device");
    service.input(task.id, { generation: terminal.generation, inputId: randomUUID(), data: "printf 'PERSISTED_HISTORY\\n'\r" });
    await until(async () => /(?:^|\n)PERSISTED_HISTORY(?:\n|$)/.test((await service.read(task.id)).screenText));
    await service.close(); f.database.close();
    const database = new AppDatabase(f.config); const tasks = new TaskService(database);
    service = new TerminalService(database, tasks);
    try {
      const restored = await service.read(task.humanId);
      assert.equal(restored.state, "interrupted"); assert.ok(restored.data.includes("PERSISTED_HISTORY"));
      for (let poll = 0; poll < 3; poll++) {
        const unchanged = await service.read(task.id, restored.generation, restored.cursor, true);
        assert.equal(unchanged.reset, false, "Polling a saved screen must not clear and replay it");
        assert.equal(unchanged.data, "");
      }
      assert.equal((await service.read(task.id, restored.generation, restored.cursor - 1)).reset, true,
        "A client behind the saved screen still needs a full snapshot");
      assert.equal(tasks.listTasks({ tab: "active" })[0]?.sessionKind, "terminal");
      assert.throws(() => service.input(task.id, { generation: restored.generation, inputId: randomUUID(), data: "echo nope\r" }), /not running/);
      await service.start(task.id);
      assert.equal((await service.read(task.id)).state, "running");
    } finally { await service.close(); database.close(); }
  } finally { /* Closed explicitly to test reopening the actual database. */ }
});

test("terminal HTTP endpoints enforce authentication, origin, kind and validated payloads", async () => {
  const f = fixture(); const app = await buildApp(f.config, f.database, { generateTitle: async () => "unused" });
  const token = new AuthService(f.database, 1).createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  try {
    const create = { method: "POST" as const, url: "/api/terminals", payload: { projectId: f.project.id, creationKey: randomUUID() } };
    assert.equal((await app.inject(create)).statusCode, 401);
    assert.equal((await app.inject({ ...create, headers: { ...headers, origin: "https://evil.invalid" } })).statusCode, 403);
    assert.equal((await app.inject({ ...create, headers, payload: { ...create.payload, creationKey: "invalid" } })).statusCode, 400);
    const result = await app.inject({ ...create, headers }); assert.equal(result.statusCode, 201, result.body);
    const { task, terminal } = result.json();
    assert.equal((await app.inject({ ...create, headers })).json().task.id, task.id);
    const base = `/api/tasks/${task.humanId}/terminal`;
    assert.equal((await app.inject({ url: base })).statusCode, 401);
    assert.equal((await app.inject({ url: base, headers })).json().terminal.state, "running");
    assert.equal((await app.inject({ method: "POST", url: `${base}/input`, headers, payload: { data: "echo no" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `${base}/input`, headers, payload: { generation: terminal.generation, inputId: randomUUID(), data: "true\r" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: `${base}/size`, headers, payload: { generation: terminal.generation, cols: 80, rows: -1 } })).statusCode, 400);
    for (const path of ["workspace", "trigger", "messages", "interrupt"]) {
      const response = await app.inject({ method: path === "workspace" ? "GET" : "POST", url: `/api/tasks/${task.id}/${path}`, headers,
        ...(path === "messages" ? { payload: { message: "must never launch Codex" } } : {}) });
      assert.equal(response.statusCode, 409, `${path}: ${response.body}`);
    }
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE owner_type = 'task' AND owner_id = ?").get(task.id)!.n, 0);
    const regular = f.tasks.createTask({ projectId: f.project.id, title: "Regular" }, "user");
    assert.equal((await app.inject({ url: `/api/tasks/${regular.id}/terminal`, headers })).statusCode, 409);
  } finally { await app.close(); }
});

test("Codex portfolio snapshots and triggers exclude terminal conversations", async () => {
  const f = fixture(); const service = new TerminalService(f.database, f.tasks);
  const attachments = new AttachmentService(f.database);
  const agents = new AgentService(f.database, f.tasks, attachments);
  try {
    const { task } = await service.create(f.project.id, randomUUID(), "device");
    assert.throws(() => agents.workspace("task", task.id), /terminal session/);
    await assert.rejects(agents.triggerTask(task.id), /terminal session/);
    assert.equal(agents.capacity().activeTurns, 0);
  } finally { agents.close(); attachments.close(); await service.close(); f.database.close(); }
});

test("deployed receipt schema accepts chat commands without storing input hashes", async () => {
  const f = fixture();
  // Exact shape found in the deployed database: required legacy column, no default.
  f.database.db.exec(`DROP TABLE terminal_input_receipts;
    CREATE TABLE terminal_input_receipts (
      task_id TEXT NOT NULL REFERENCES terminal_sessions(task_id), generation TEXT NOT NULL,
      input_id TEXT NOT NULL, data_hash TEXT NOT NULL, PRIMARY KEY(task_id, generation, input_id));`);
  const service = new TerminalService(f.database, f.tasks);
  try {
    const { task, terminal } = await service.create(f.project.id, randomUUID(), "device");
    const message = "printf 'UPGRADE_WORKS\\n'";
    const input = { generation: terminal.generation, inputId: randomUUID(), message, data: `${message}\r` };
    service.input(task.id, input); service.input(task.id, input);
    await until(async () => (await service.read(task.id)).messages.some(entry => entry.role === "assistant" && entry.body === "UPGRADE_WORKS"));
    const view = await service.read(task.id);
    assert.equal(view.messages.filter(entry => entry.role === "user").length, 1);
    assert.equal(view.messages.find(entry => entry.role === "user")?.body, message);
    assert.equal(f.database.db.prepare("SELECT data_hash FROM terminal_input_receipts").get()!.data_hash, "");
  } finally { await service.close(); f.database.close(); }
});

test("normal chat saves separate commands and output, streams and preserves history with hidden prompts", async () => {
  const f = fixture(); const service = new TerminalService(f.database, f.tasks);
  try {
    const { task, terminal } = await service.create(f.project.id, randomUUID(), "device");
    const send = (message: string) => service.input(task.id, { generation: terminal.generation, inputId: randomUUID(), data: `${message}\r`, message });
    send("printf 'first\\n'; sleep 0.15; printf 'second\\n'");
    await until(async () => (await service.read(task.id)).messages.at(-1)?.body === "first");
    await until(async () => (await service.read(task.id)).messages.at(-1)?.body === "first\nsecond");
    send("read -rs -p 'Password: ' QAH_SECRET; unset QAH_SECRET; printf '\\nPASSWORD_ACCEPTED\\n'");
    await until(async () => (await service.read(task.id)).messages.at(-1)?.body === "Password:");
    send("never-save-this");
    await until(async () => (await service.read(task.id)).messages.at(-1)?.body.includes("PASSWORD_ACCEPTED") === true);
    const view = await service.read(task.humanId);
    assert.ok(view.messages.some(entry => entry.role === "user" && entry.body === "Hidden input"));
    assert.ok(!JSON.stringify(view).includes("never-save-this"));
    const ids = view.messages.map(entry => entry.id);
    assert.deepEqual((await service.read(task.id)).messages.map(entry => entry.id), ids);
    send("qahwa_missing_test_command");
    await until(async () => (await service.read(task.id)).messages.at(-1)?.body.includes("command not found") === true);
  } finally { await service.close(); f.database.close(); }
});
