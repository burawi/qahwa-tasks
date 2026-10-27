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

test("paired task sessions save named canvas versions and restore them safely", async () => {
  const { config, database, root, tasks, headers } = fixture();
  const project = tasks.createProject({ name: "Canvas", prefix: "CAN", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Design", status: "todo" }, "user");
  const original = { format: "web", artboard: { width: 390, height: 844, background: "#fff", name: "Original" }, html: '<main data-qahwa-id="root">Original</main>', css: "main{padding:20px}" };
  database.db.prepare("INSERT INTO design_documents(task_id, document_json, revision, updated_at) VALUES (?, ?, 1, ?)")
    .run(task.id, JSON.stringify(original), new Date().toISOString());
  const app = await buildApp(config, database);
  try {
    const humanWorkspace = await app.inject({ method: "GET", url: `/api/tasks/${task.humanId}/workspace`, headers });
    assert.equal(humanWorkspace.statusCode, 200);
    assert.equal(humanWorkspace.json().workspace.session.ownerId, task.id);
    const saved = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/design/versions`, headers, payload: { name: "Approved direction" } });
    assert.equal(saved.statusCode, 200);
    const versionId = saved.json().workspace.designVersions[0].id as string;
    database.db.prepare("UPDATE design_documents SET document_json = ?, revision = 2 WHERE task_id = ?")
      .run(JSON.stringify({ ...original, artboard: { ...original.artboard, name: "Changed" } }), task.id);
    const restored = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/design/versions/${versionId}/restore`, headers });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().workspace.design.document.artboard.name, "Original");
    assert.equal(restored.json().workspace.design.revision, 3);
  } finally { await app.close(); }
});
