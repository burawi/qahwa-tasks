import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { ChatModels } from "../src/server/chat-models.js";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";


// Exercise the actual app-server transport without model calls or user data.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-orchestrator-"));
  const capture = join(root, "requests.jsonl");
  const response = join(root, "response.txt");
  writeFileSync(response, "Ready.");
  writeFileSync(join(root, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const record = value => fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(value) + "\\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
record({ argv: process.argv.slice(2) });
let nextThread = 0, nextTurn = 0;
const activeTurns = new Map();
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  record(request);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "model/list") result = { data: [
    { model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", defaultReasoningEffort: "low", supportedReasoningEfforts: [{reasoningEffort:"low",description:"Fast"},{reasoningEffort:"high",description:"Deep"}] },
    { model: "gpt-6-astra", displayName: "GPT-6 Astra", defaultReasoningEffort: "high", supportedReasoningEfforts: [{reasoningEffort:"medium",description:"Balanced"},{reasoningEffort:"high",description:"Deep"}] }
  ], nextCursor: null };
  if (request.method === "thread/start") result = { thread: { id: "thread-" + ++nextThread } };
  if (request.method === "turn/start") {
    const threadId = request.params.threadId, turnId = "turn-" + ++nextTurn;
    activeTurns.set(threadId, turnId);
    result = { turn: { id: turnId } };
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId, turnId, item: {
        id: "item-" + turnId, type: "agentMessage", phase: "final_answer",
        text: fs.readFileSync(${JSON.stringify(response)}, "utf8")
      } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      if (activeTurns.get(threadId) === turnId) activeTurns.delete(threadId);
    }, 20);
  }
  if (request.method === "turn/steer") {
    if (!request.params.expectedTurnId) return send({ id: request.id, error: { code: -32600, message: "Invalid request: missing field expectedTurnId" } });
    if (activeTurns.get(request.params.threadId) !== request.params.expectedTurnId) return send({ id: request.id, error: { code: -32600, message: "no active turn" } });
    result = { turnId: request.params.expectedTurnId };
  }
  send({ id: request.id, result });
});
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  const database = new AppDatabase({ host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost",
    dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 });
  const tasks = new TaskService(database);
  const attachments = new AttachmentService(database, join(root, "attachments"));
  const agents = new AgentService(database, tasks, attachments);
  return {
    root, database, tasks, agents, config: { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 },
    reply(body: string) { writeFileSync(response, body); },
    requests(): Array<{ argv?: string[]; method?: string; params: Record<string, any> }> {
      return readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    },
    async settled(ownerType: "orchestrator" | "task", ownerId: string) {
      const deadline = Date.now() + 5_000;
      while (agents.workspace(ownerType, ownerId).session.runState === "running") {
        assert.ok(Date.now() < deadline, "Fake app-server turn did not complete");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return agents.workspace(ownerType, ownerId);
    },
    close() {
      agents.close();
      attachments.close();
      database.close();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("per-chat selections persist, validate, and reach fresh and resumed turns without changing history", async () => {
  const f = fixture();
  try {
    const project = f.tasks.createProject({ name: "Models", prefix: "MOD", rootDirectory: f.root }, "user");
    const task = f.tasks.createTask({ projectId: project.id, title: "Model acceptance" }, "user");
    const other = f.tasks.createTask({ projectId: project.id, title: "Other chat" }, "user");
    assert.deepEqual(f.agents.workspace("task", task.id).modelSettings, { model: "gpt-6.1-sol", effort: "high" });
    assert.deepEqual(f.agents.workspace("orchestrator", "main").modelSettings, { model: "gpt-6-astra", effort: "high" });
    await f.agents.saveChatModel("task", task.humanId, { model: "gpt-6-astra", effort: "medium" });
    await f.agents.saveChatModel("orchestrator", "main", { model: "gpt-6.1-sol", effort: "low" });
    await assert.rejects(f.agents.saveChatModel("task", task.id, { model: "unknown", effort: "low" }), /unavailable/);
    await assert.rejects(f.agents.saveChatModel("task", task.id, { model: "gpt-6-astra", effort: "low" }), /supported/);
    await assert.rejects(f.agents.saveChatModel("task", task.id, null), /Choose a model/);
    await assert.rejects(f.agents.saveChatModel("task", "missing", { model: "gpt-6-astra", effort: "high" }));
    assert.deepEqual(f.agents.workspace("task", other.id).modelSettings, { model: "gpt-6.1-sol", effort: "high" });
    const reopened = new AppDatabase(f.config);
    try {
      const preferences = new ChatModels(reopened, { initialize: async () => {}, request: async () => ({}) });
      assert.deepEqual(preferences.settings("task", task.id), { model: "gpt-6-astra", effort: "medium" });
      assert.deepEqual(preferences.settings("orchestrator", "main"), { model: "gpt-6.1-sol", effort: "low" });
    } finally { reopened.close(); }
    for (const [type, id] of [["task", task.id], ["orchestrator", "main"]] as const) {
      await f.agents.send(type, id, "First selected turn");
      // Changing the picker during a running turn must not steer or interrupt it.
      const before = f.agents.workspace(type, id);
      await f.agents.saveChatModel(type, id, { model: "gpt-6-astra", effort: "high" });
      const saved = f.agents.workspace(type, id);
      assert.equal(saved.session.threadId, before.session.threadId);
      assert.deepEqual(saved.messages, before.messages);
      await f.settled(type, id);
      await f.agents.send(type, id, "Next selected turn");
      const next = await f.settled(type, id);
      assert.equal(next.session.threadId, before.session.threadId);
    }
    const starts = f.requests().filter(request => request.method === "turn/start");
    assert.deepEqual(starts.map(request => [request.params.model, request.params.effort]), [
      ["gpt-6-astra", "medium"], ["gpt-6-astra", "high"], ["gpt-6.1-sol", "low"], ["gpt-6-astra", "high"],
    ]);
    assert.equal(f.requests().filter(request => request.method === "model/list").length, 1);
    assert.equal(f.requests().filter(request => ["turn/steer", "turn/interrupt"].includes(request.method ?? "")).length, 0);
    f.agents.close();
    const app = await buildApp(f.config, f.database, { generateTitle: async () => "Acceptance" });
    try {
      const now = new Date().toISOString();
      f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('models','Models','',?,?)").run(now, now);
      const { token } = new AuthService(f.database, 365).createSession(null, null, "models");
      const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
      assert.equal((await app.inject({ url: "/api/chat-models" })).statusCode, 401);
      assert.equal((await app.inject({ url: "/api/chat-models", headers })).json().models.length, 2);
      for (const url of [`/api/tasks/${task.humanId}/model`, "/api/orchestrator/model"]) {
        const response = await app.inject({ method: "PUT", url, headers, payload: { model: "gpt-6.1-sol", effort: "low" } });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json().workspace.modelSettings, { model: "gpt-6.1-sol", effort: "low" });
        assert.equal((await app.inject({ method: "PUT", url, headers, payload: { model: "gpt-6-astra", effort: "low" } })).statusCode, 400);
      }
      const read = await app.inject({ url: `/api/tasks/${task.id}/workspace`, headers });
      assert.deepEqual(read.json().workspace.modelSettings, { model: "gpt-6.1-sol", effort: "low" });
    } finally { await app.close(); }
  } finally { f.close(); }
});

test("catalog uses pagination and model-specific efforts; failures preserve saved choices", async () => {
  const f = fixture();
  try {
    let calls = 0, fail = true;
    const models = new ChatModels(f.database, { initialize: async () => {}, request: async (_method, params) => {
      calls++;
      if (fail) throw new Error("Models offline");
      return params.cursor ? { data: [{ model: "two", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "max", description: "Deep" }], defaultReasoningEffort: "max" }], nextCursor: null }
        : { data: [{ model: "hidden", hidden: true, supportedReasoningEfforts: [] }], nextCursor: "page-2" };
    } });
    await assert.rejects(models.save("orchestrator", "main", { model: "two", effort: "max" }), /offline/);
    assert.equal(f.database.setting("chat_model:orchestrator:main"), null);
    fail = false;
    const [first, second] = await Promise.all([models.list(), models.list()]);
    assert.deepEqual(first, second); assert.equal(first.length, 1); assert.equal(calls, 3);
    await models.save("orchestrator", "main", { model: "two", effort: "max" });
    assert.deepEqual(models.settings("orchestrator", "main"), { model: "two", effort: "max" });
  } finally { f.close(); }
});

test("new-chat defaults persist while existing implicit and explicit choices stay unchanged", async () => {
  const f = fixture();
  try {
    const project = f.tasks.createProject({ name: "Defaults", prefix: "DFT", rootDirectory: f.root }, "user");
    const task = () => f.tasks.createTask({ projectId: project.id, title: "Default acceptance" }, "user");
    const current = task(), old = task(), explicit = task();
    f.agents.workspace("task", current.id);
    f.agents.workspace("task", old.id);
    f.agents.workspace("orchestrator", "main");
    await f.agents.saveChatModel("task", explicit.id, { model: "gpt-6.1-sol", effort: "low" });
    await assert.rejects(f.agents.saveChatModel("task", current.id, { model: "gpt-6-astra", effort: "low", useAsDefault: true }));
    assert.equal(f.database.setting("chat_model_default"), null);
    await assert.rejects(f.agents.saveChatModel("task", current.id, { model: "gpt-6-astra", effort: "medium", useAsDefault: "yes" }));
    await f.agents.saveChatModel("task", current.id, { model: "gpt-6-astra", effort: "medium", useAsDefault: true });
    assert.deepEqual(f.agents.workspace("task", old.id).modelSettings, { model: "gpt-6.1-sol", effort: "high" });
    assert.deepEqual(f.agents.workspace("task", explicit.id).modelSettings, { model: "gpt-6.1-sol", effort: "low" });
    assert.deepEqual(f.agents.workspace("orchestrator", "main").modelSettings, { model: "gpt-6-astra", effort: "high" });
    const fresh = task();
    assert.deepEqual(f.agents.workspace("task", fresh.id).modelSettings, { model: "gpt-6-astra", effort: "medium" });
    await f.agents.send("task", fresh.id, "Use new default");
    await f.settled("task", fresh.id);
    const turn = f.requests().filter(request => request.method === "turn/start").at(-1)!;
    assert.equal(turn.params.model, "gpt-6-astra"); assert.equal(turn.params.effort, "medium");
    await f.agents.saveChatModel("orchestrator", "main", { model: "gpt-6.1-sol", effort: "low", useAsDefault: true });
    assert.deepEqual(f.agents.workspace("task", fresh.id).modelSettings, { model: "gpt-6-astra", effort: "medium" });
    assert.deepEqual(f.agents.workspace("task", task().id).modelSettings, { model: "gpt-6.1-sol", effort: "low" });
    const reopened = new AppDatabase(f.config);
    try {
      const models = new ChatModels(reopened, { initialize: async () => {}, request: async () => ({}) });
      assert.deepEqual(models.settings("task", "future"), { model: "gpt-6.1-sol", effort: "low" });
    } finally { reopened.close(); }
    await f.agents.saveChatModel("orchestrator", "main", { model: "gpt-6-astra", effort: "high" });
    assert.deepEqual(JSON.parse(f.database.setting("chat_model_default")!), { model: "gpt-6.1-sol", effort: "low" });
  } finally { f.close(); }
});

