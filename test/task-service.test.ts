import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentFromPlainText } from "../src/domain/types.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-test-"));
  const root = join(dataDir, "project");
  mkdirSync(root);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "missing-token"),
  };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: root }, "user");
  return { database, tasks, project, root };
}

test("creates human-readable IDs and globally ordered tasks", () => {
  const { database, tasks, project } = fixture();
  try {
    const first = tasks.createTask({ projectId: project.id, title: "First" }, "user");
    const second = tasks.createTask({ projectId: project.id, title: "Second" }, "user");
    assert.equal(first.humanId, "WAS-0001");
    assert.equal(second.humanId, "WAS-0002");
    assert.deepEqual(tasks.listTasks({ tab: "backlog" }).map((task) => task.humanId), ["WAS-0001", "WAS-0002"]);
    tasks.reorder(second.id, { afterId: first.id }, "user");
    assert.deepEqual(tasks.listTasks({ tab: "backlog" }).map((task) => task.humanId), ["WAS-0002", "WAS-0001"]);
  } finally { database.close(); }
});

test("enforces the agreed workflow and explicit Codex closure", () => {
  const { database, tasks, project } = fixture();
  try {
    const task = tasks.createTask({ projectId: project.id, title: "Workflow" }, "codex");
    assert.throws(() => tasks.transition(task.id, { to: "in_progress" }, "codex"), /Cannot move backlog/);
    tasks.transition(task.id, { to: "todo" }, "user");
    tasks.transition(task.id, { to: "in_progress" }, "codex");
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE event_type = 'started'").get().count, 1);
    tasks.submitForReview(task.id, { sessionId: "session-1", summary: "Implemented", validation: ["Tests passed"] }, "codex");
    assert.equal(tasks.getTask(task.id).status, "in_review");
    assert.throws(() => tasks.transition(task.id, { to: "closed", outcome: "completed" }, "codex"), /explicit user instruction/);
    const closed = tasks.transition(task.id, {
      to: "closed", outcome: "completed", explicitUserInstruction: "Close WAS-0001 as completed",
    }, "codex");
    assert.equal(closed.outcome, "completed");
    assert.throws(() => tasks.transition(task.id, { to: "todo" }, "user"), /Cannot move closed/);
  } finally { database.close(); }
});

test("only Codex returns review feedback to in-progress and keeps threaded comments", () => {
  const { database, tasks, project } = fixture();
  try {
    const created = tasks.createTask({ projectId: project.id, title: "Comments", status: "todo" }, "user");
    tasks.transition(created.id, { to: "in_progress" }, "codex");
    tasks.submitForReview(created.id, { summary: "First pass" }, "codex");
    const root = tasks.addComment(created.id, { body: documentFromPlainText("Please adjust spacing") }, "user");
    assert.equal(tasks.getTask(created.id).status, "in_review");
    assert.throws(
      () => tasks.transition(created.id, { to: "in_progress" }, "user"),
      /Only Codex can return an in-review task to work/,
    );
    assert.throws(
      () => tasks.transition(created.id, { to: "in_progress" }, "system"),
      /Only Codex can return an in-review task to work/,
    );
    tasks.transition(created.id, { to: "in_progress" }, "codex");
    tasks.resolveComment(root.id, true, "codex", documentFromPlainText("Spacing adjusted"));
    const task = tasks.getTask(created.id);
    assert.equal(task.status, "in_progress");
    assert.equal(task.comments[1]?.resolvedAt === null, false);
    assert.equal(task.comments[1]?.replies[0]?.plainText, "Spacing adjusted");
  } finally { database.close(); }
});

test("deletes only Backlog tasks and only empty projects", () => {
  const { database, tasks, project } = fixture();
  try {
    const task = tasks.createTask({ projectId: project.id, title: "Disposable" }, "user");
    assert.throws(() => tasks.deleteProject(project.id, "user"), /without tasks/);
    tasks.deleteBacklogTask(task.id, "user");
    tasks.deleteProject(project.id, "user");
    assert.equal(tasks.listProjects(true).length, 0);
  } finally { database.close(); }
});

test("protects edits with optimistic task versions", () => {
  const { database, tasks, project } = fixture();
  try {
    const task = tasks.createTask({ projectId: project.id, title: "Versioned" }, "user");
    tasks.updateTask(task.id, { title: "Changed", expectedVersion: 1 }, "user");
    assert.throws(() => tasks.updateTask(task.id, { title: "Stale", expectedVersion: 1 }, "codex"), /changed since/);
  } finally { database.close(); }
});
