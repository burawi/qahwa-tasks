import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addRelatedTask, removeRelatedTask, returnTaskToWork } from "../src/mcp/workflow.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";

test("MCP return-to-work adapter preserves the Codex-only review transition", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-mcp-"));
  const root = join(dataDir, "project");
  mkdirSync(root);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "missing-token"),
  };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  try {
    const project = tasks.createProject({ name: "MCP Review", prefix: "MCP", rootDirectory: root }, "codex");
    const created = tasks.createTask({ projectId: project.id, title: "Return task", status: "todo" }, "codex");
    tasks.transition(created.id, { to: "in_progress" }, "codex");
    tasks.submitForReview(created.id, { summary: "Ready", artifacts: ["report.txt"] }, "codex");
    assert.equal(tasks.getTask(created.id).outputs[0]?.summary, "Ready");
    assert.deepEqual(tasks.getTask(created.id).outputs[0]?.artifacts, [{
      source: "report.txt", sourceType: "path", filename: "report.txt", mediaType: null, size: null,
      previewKind: "none", availability: "missing", previewUrl: null,
    }]);
    assert.equal(returnTaskToWork(tasks, created.id).status, "in_progress");
  } finally { database.close(); }
});

test("MCP relationship adapters add and remove links by human ID", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-mcp-related-"));
  const root = join(dataDir, "project");
  mkdirSync(root);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "missing-token"),
  };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  try {
    const project = tasks.createProject({ name: "MCP Links", prefix: "LNK", rootDirectory: root }, "codex");
    const first = tasks.createTask({ projectId: project.id, title: "First" }, "codex");
    const second = tasks.createTask({ projectId: project.id, title: "Second" }, "codex");
    assert.equal(addRelatedTask(tasks, first.humanId, second.humanId).relatedTasks[0]?.humanId, second.humanId);
    assert.deepEqual(removeRelatedTask(tasks, second.humanId, first.humanId).relatedTasks, []);
  } finally { database.close(); }
});
