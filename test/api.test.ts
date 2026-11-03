import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { projectLogoPng } from "./helpers/project-logo.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-api-"));
  const root = join(dataDir, "project");
  mkdirSync(root);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365,
  };
  const database = new AppDatabase(config);
  const timestamp = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('test-device', 'Test', '', ?, ?)")
    .run(timestamp, timestamp);
  const token = new AuthService(database, 365).createSession("test", "127.0.0.1", "test-device").token;
  const headers = { authorization: `Bearer ${token}`, origin: config.publicBaseUrl };
  return { config, database, root, tasks: new TaskService(database), headers };
}

test("project logo HTTP uploads accept up to 2 MiB and return useful oversize errors", async () => {
  const { config, database, root, tasks, headers } = fixture();
  const project = tasks.createProject({ name: "Logos", prefix: "LOG", rootDirectory: root }, "user");
  const app = await buildApp(config, database);
  const url = `/api/projects/${project.id}/logo`;
  try {
    for (const size of [256 * 1024 + 1, 512 * 1024 + 1, 2 * 1024 * 1024]) {
      const png = projectLogoPng(size);
      const uploaded = await app.inject({ method: "PUT", url, headers: { ...headers, "content-type": "image/png" }, payload: png });
      assert.equal(uploaded.statusCode, 200, uploaded.body);
      assert.equal(uploaded.json().project.logo.size, size);
      const downloaded = await app.inject({ method: "GET", url, headers });
      assert.equal(downloaded.statusCode, 200);
      assert.deepEqual(downloaded.rawPayload, png);
    }
    for (const size of [2 * 1024 * 1024 + 1, 3 * 1024 * 1024]) {
      const rejected = await app.inject({ method: "PUT", url, headers: { ...headers, "content-type": "image/png" }, payload: projectLogoPng(size) });
      assert.equal(rejected.statusCode, 413);
      assert.deepEqual(rejected.json(), { error: "project_logo_too_large", message: "Logo must be 2 MB or smaller" });
    }
    assert.equal((await app.inject({ method: "GET", url, headers })).rawPayload.length, 2 * 1024 * 1024);
    const unrelated = await app.inject({ method: "POST", url: "/api/projects", headers, payload: { name: "a".repeat(512 * 1024) } });
    assert.equal(unrelated.statusCode, 413);
  } finally { await app.close(); }
});

test("API accepts only encrypted-device sessions and exposes no password endpoints", async () => {
  const { config, database, headers } = fixture();
  const app = await buildApp(config, database);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { password: "unused" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/setup", headers, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers })).statusCode, 200);
  } finally { await app.close(); }
});

test("paired API serves task-scoped artifacts and rejects cross-task access", async () => {
  const { config, database, root, tasks, headers } = fixture();
  writeFileSync(join(root, "preview.png"), Buffer.from("preview-bytes"));
  const project = tasks.createProject({ name: "Artifacts", prefix: "ART", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Preview", status: "todo" }, "user");
  const other = tasks.createTask({ projectId: project.id, title: "Other", status: "todo" }, "user");
  const output = tasks.addOutput(task.id, { summary: "File", artifacts: ["preview.png"] }, "codex");
  const path = `/api/tasks/${task.id}/outputs/${output.id}/artifacts/0`;
  const app = await buildApp(config, database);
  try {
    const fetched = await app.inject({ method: "GET", url: path, headers });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.body, "preview-bytes");
    assert.equal((await app.inject({ method: "GET", url: path.replace(task.id, other.id), headers })).statusCode, 404);
  } finally { await app.close(); }
});

test("paired canvas pages create, switch and rename without save or restore endpoints", async () => {
  const { config, database, root, tasks, headers } = fixture();
  const project = tasks.createProject({ name: "Canvas", prefix: "CAN", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Design", status: "todo" }, "user");
  const other = tasks.createTask({ projectId: project.id, title: "Other", status: "todo" }, "user");
  const app = await buildApp(config, database);
  const base = `/api/tasks/${task.humanId}/design/pages`;
  try {
    assert.equal((await app.inject({ method: "POST", url: base, payload: { name: "Home" } })).statusCode, 401);
    const create = async (name: unknown) => app.inject({ method: "POST", url: base, headers, payload: { name } });
    const first = await create("Home");
    assert.equal(first.statusCode, 200, first.body);
    const id = first.json().workspace.selectedDesignPageId;
    const second = await create("Details");
    assert.equal(second.json().workspace.designPages.length, 2);
    assert.equal(second.json().workspace.design.document.html, "");
    const renamed = await app.inject({ method: "PATCH", url: `${base}/${id}`, headers, payload: { name: "Landing" } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const selected = await app.inject({ method: "POST", url: `${base}/${id}/select`, headers });
    assert.equal(selected.json().workspace.selectedDesignPageId, id);
    assert.equal(selected.json().workspace.designPages[0].name, "Landing");
    for (const name of ["", " ", "x".repeat(81), 1, null]) assert.equal((await create(name)).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${other.id}/design/pages/${id}/select`, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/tasks/${other.id}/design/pages/${id}`, headers, payload: { name: "Wrong task" } })).statusCode, 404);
    const comment = await app.inject({ method: "POST", url: `/api/tasks/${other.id}/comments`, headers, payload: { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wrong page" }] }] }, metadata: { canvas: { pageId: id } } } });
    assert.equal(comment.statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/design/versions`, headers, payload: { name: "Old" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/design/versions/${id}/restore`, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/api/tasks/${task.humanId}/workspace`, headers })).json().workspace.session.ownerId, task.id);
  } finally { await app.close(); }
  const reopened = new AppDatabase(config);
  try {
    assert.equal(reopened.db.prepare("SELECT page_id FROM design_page_selection WHERE task_id = ?").get(task.id)!.page_id !== undefined, true);
    assert.equal(reopened.db.prepare("SELECT name FROM design_pages WHERE task_id = ? ORDER BY rowid LIMIT 1").get(task.id)!.name, "Landing");
  } finally { reopened.close(); }
});

test("canvas comments persist item anchors and user/bot resolution without starting work", async () => {
  const { config, database, root, tasks, headers } = fixture();
  const project = tasks.createProject({ name: "Canvas comments", prefix: "COM", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Canvas feedback", status: "todo" }, "user");
  const app = await buildApp(config, database, { generateTitle: async () => "Canvas feedback" });
  const anchor = { elementId: "button-buy", label: "button-buy (button): Buy", revision: 3, versionId: "current" };
  const url = `/api/tasks/${task.humanId}/comments`;
  const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Increase contrast" }] }] };
  try {
    assert.equal((await app.inject({ method: "POST", url, payload: { body } })).statusCode, 401);
    const saved = await app.inject({ method: "POST", url, headers, payload: { body, metadata: { canvas: anchor } } });
    assert.equal(saved.statusCode, 201, saved.body);
    const id = saved.json().comment.id as string;
    const read = async () => (await app.inject({ method: "GET", url: `/api/tasks/${task.humanId}`, headers })).json().task;
    assert.deepEqual((await read()).comments[0].metadata.canvas, anchor);
    assert.equal((await read()).status, "todo");
    assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()!.n, 0);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM scheduler_queue").get()!.n, 0);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE owner_type = 'task'").get()!.n, 0);
    const resolution = `/api/comments/${id}/resolution`;
    assert.equal((await app.inject({ method: "POST", url: resolution, headers, payload: { resolved: true } })).statusCode, 200);
    assert.ok((await read()).comments[0].resolvedAt);
    tasks.resolveComment(id, false, "codex");
    assert.equal((await read()).comments[0].resolvedAt, null);
    tasks.resolveComment(id, true, "codex", body);
    assert.equal((await read()).comments[0].replies[0].author, "codex");
    await app.inject({ method: "POST", url: resolution, headers, payload: { resolved: false } });
    assert.equal((await read()).comments[0].resolvedAt, null);
    assert.deepEqual((await read()).comments[0].metadata.canvas, anchor);
    assert.equal((await read()).status, "todo");
  } finally { await app.close(); }
  const reopenedDatabase = new AppDatabase(config);
  try { assert.deepEqual(new TaskService(reopenedDatabase).getTask(task.id).comments[0]?.metadata?.canvas, anchor); }
  finally { reopenedDatabase.close(); }
});

test("both chat endpoints support conditional polling without changing legacy full-history reads", async () => {
  const { config, database, root, tasks, headers } = fixture();
  const project = tasks.createProject({ name: "Chat polling", prefix: "CHT", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Long chat", status: "todo" }, "user");
  const app = await buildApp(config, database);
  try {
    for (const [path, ownerType, ownerId] of [[`/api/tasks/${task.humanId}/workspace`, "task", task.id], ["/api/orchestrator", "orchestrator", "main"]]) {
      const read = async (query = "") => {
        const result = await app.inject({ method: "GET", url: path + query, headers });
        assert.equal(result.statusCode, 200, result.body);
        return result.json();
      };
      database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)")
        .run(`${ownerType}-message`, ownerType, ownerId, "Original history", new Date().toISOString());
      const initial = await read("?poll=1");
      assert.equal(initial.workspace.messages.at(-1).body, "Original history");
      const cursor = `?poll=1&revision=${initial.revision}&messagesRevision=${initial.messagesRevision}`;
      assert.equal((await read(cursor)).workspace, null);
      database.db.prepare("UPDATE agent_sessions SET run_state = 'waiting' WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
      const activity = await read(cursor);
      assert.equal(activity.workspace.session.runState, "waiting");
      assert.equal(activity.workspace.messages, undefined);
      database.db.prepare("UPDATE chat_messages SET body = 'Edited history' WHERE id = ?").run(`${ownerType}-message`);
      assert.equal((await read(cursor)).workspace.messages.at(-1).body, "Edited history");
      assert.equal((await read()).workspace.messages.at(-1).body, "Edited history");
      database.db.prepare("DELETE FROM chat_messages WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
      assert.deepEqual((await read(cursor)).workspace.messages, []);
    }
  } finally { await app.close(); }
});
