import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { returnTaskToWork } from "../src/mcp/workflow.js";
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
    tasks.submitForReview(created.id, { summary: "Ready" }, "codex");
    assert.equal(returnTaskToWork(tasks, created.id).status, "in_progress");
  } finally { database.close(); }
});
