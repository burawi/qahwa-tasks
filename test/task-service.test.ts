import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentFromPlainText } from "../src/domain/types.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { projectLogoPng } from "./helpers/project-logo.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-test-"));
  const root = join(dataDir, "project");
  mkdirSync(root);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365,
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
    tasks.prioritize([first.humanId, second.humanId], "system");
    assert.deepEqual(tasks.listTasks({ tab: "backlog" }).map((task) => task.humanId), ["WAS-0001", "WAS-0002"]);
  } finally { database.close(); }
});

test("enforces the agreed workflow and explicit Codex closure", () => {
  const { database, tasks, project } = fixture();
  try {
    const task = tasks.createTask({ projectId: project.id, title: "Workflow" }, "codex");
    assert.throws(() => tasks.transition(task.id, { to: "in_progress" }, "codex"), /Cannot move backlog/);
    tasks.transition(task.id, { to: "todo" }, "user");
    tasks.transition(task.id, { to: "in_progress" }, "codex");
    tasks.submitForReview(task.id, { sessionId: "session-1", summary: "Implemented", validation: ["Tests passed"] }, "codex");
    const reviewed = tasks.getTask(task.id);
    assert.equal(reviewed.status, "in_review");
    assert.equal(reviewed.outputs[0]?.summary, "Implemented");
    assert.deepEqual(reviewed.outputs[0]?.validation, ["Tests passed"]);
    assert.equal(reviewed.outputs[0]?.sessionId, "session-1");
    assert.equal(reviewed.comments.length, 0);
    assert.throws(() => tasks.transition(task.id, { to: "closed", outcome: "completed" }, "codex"), /explicit user instruction/);
    const closed = tasks.transition(task.id, {
      to: "closed", outcome: "completed", explicitUserInstruction: "Close WAS-0001 as completed",
    }, "codex");
    assert.equal(closed.outcome, "completed");
    assert.throws(() => tasks.transition(task.id, { to: "todo" }, "user"), /Cannot move closed/);
  } finally { database.close(); }
});

test("task lifecycle keeps response-required comments in the task record", () => {
  const { database, tasks, project } = fixture();
  try {
    const task = tasks.createTask({ projectId: project.id, title: "Quiet workflow", status: "todo" }, "codex");
    tasks.transition(task.id, { to: "in_progress" }, "codex");
    const comment = tasks.addComment(task.id, {
      body: documentFromPlainText("Please confirm the result"), requiresResponse: true,
    }, "codex");
    assert.equal(comment.requiresResponse, true);
    assert.equal(tasks.getTask(task.id).comments[0]?.plainText, "Please confirm the result");
    tasks.submitForReview(task.id, { summary: "Ready for review" }, "codex");
    assert.equal(tasks.getTask(task.id).status, "in_review");
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
    assert.equal(task.comments[0]?.resolvedAt === null, false);
    assert.equal(task.comments[0]?.replies[0]?.plainText, "Spacing adjusted");
  } finally { database.close(); }
});

test("appends structured outputs chronologically with complete provenance", () => {
  const { database, tasks, project } = fixture();
  try {
    const created = tasks.createTask({ projectId: project.id, title: "Outputs", status: "todo" }, "codex");
    tasks.transition(created.id, { to: "in_progress" }, "codex");
    tasks.submitForReview(created.id, {
      sessionId: "session-1", runId: "run-1", summary: "First pass", validation: ["Unit tests"],
      commit: "abc123", limitations: ["No browser QA"], artifacts: ["dist/report.json"],
    }, "codex");
    tasks.transition(created.id, { to: "in_progress" }, "codex");
    tasks.submitForReview(created.id, { sessionId: "session-2", summary: "Revision" }, "codex");
    const outputs = tasks.getTask(created.id).outputs;
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0]?.summary, "First pass");
    assert.equal(outputs[0]?.commit, "abc123");
    assert.deepEqual(outputs[0]?.limitations, ["No browser QA"]);
    assert.equal(outputs[0]?.artifacts[0]?.source, "dist/report.json");
    assert.equal(outputs[0]?.artifacts[0]?.availability, "missing");
    assert.equal(outputs[1]?.summary, "Revision");
    assert.notEqual(outputs[0]?.id, outputs[1]?.id);
  } finally { database.close(); }
});

test("removes legacy frontend preview metadata without disturbing task outputs", () => {
  const { database, tasks, project } = fixture();
  const created = tasks.createTask({ projectId: project.id, title: "Legacy preview", status: "todo" }, "codex");
  tasks.transition(created.id, { to: "in_progress" }, "codex");
  tasks.addOutput(created.id, { summary: "Keep this output", artifacts: ["dist/report.json"] }, "codex");
  database.db.exec("ALTER TABLE task_outputs ADD COLUMN preview_json TEXT");
  database.db.prepare("UPDATE task_outputs SET preview_json = ? WHERE task_id = ?").run(
    JSON.stringify({ url: "https://workstation.tailnet.ts.net:4173/", availability: "available" }),
    created.id,
  );
  const path = database.path;
  const dataDir = database.dataDir;
  database.close();

  const reopened = new AppDatabase({
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365,
  }, path);
  try {
    const columns = reopened.db.prepare("PRAGMA table_info(task_outputs)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "preview_json"), false);
    const output = new TaskService(reopened).getTask(created.id).outputs[0];
    assert.equal(output?.summary, "Keep this output");
    assert.equal(output?.artifacts[0]?.source, "dist/report.json");
  } finally { reopened.close(); }
});

test("migrates legacy handoff comments into structured outputs without removing history", () => {
  const { database, tasks, project } = fixture();
  const created = tasks.createTask({ projectId: project.id, title: "Legacy", status: "todo" }, "codex");
  tasks.addComment(created.id, {
    body: documentFromPlainText("Completed: Legacy work"), kind: "handoff",
    metadata: { summary: "Legacy work", validation: ["Legacy tests"], sessionId: "old-session" },
  }, "codex");
  const config = database.path;
  const dataDir = database.dataDir;
  database.close();
  const reopened = new AppDatabase({
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365,
  }, config);
  try {
    const migrated = new TaskService(reopened).getTask(created.id);
    assert.equal(migrated.outputs.length, 1);
    assert.equal(migrated.outputs[0]?.summary, "Legacy work");
    assert.deepEqual(migrated.outputs[0]?.validation, ["Legacy tests"]);
    assert.equal(migrated.outputs[0]?.sourceCommentId, migrated.comments[0]?.id);
    assert.equal(migrated.latestHandoff?.plainText, "Completed: Legacy work");
  } finally { reopened.close(); }
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

test("maintains deduplicated bidirectional relationships across projects", () => {
  const { database, tasks, project, root } = fixture();
  try {
    const otherProject = tasks.createProject({ name: "Majenna", prefix: "MAJ", rootDirectory: root }, "user");
    const first = tasks.createTask({ projectId: project.id, title: "First" }, "user");
    const second = tasks.createTask({ projectId: otherProject.id, title: "Second", status: "todo" }, "user");
    tasks.addRelatedTask(first.humanId, second.humanId, "codex");
    tasks.addRelatedTask(second.id, first.id, "codex");
    assert.deepEqual(tasks.getTask(first.id).relatedTasks.map((task) => task.humanId), [second.humanId]);
    assert.deepEqual(tasks.getTask(second.id).relatedTasks.map((task) => task.humanId), [first.humanId]);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM task_relationships").get().count, 1);
    assert.throws(() => tasks.addRelatedTask(first.id, first.humanId, "codex"), /cannot be related to itself/);

    tasks.transition(second.id, { to: "in_progress" }, "codex");
    tasks.transition(second.id, { to: "closed", outcome: "cancelled", explicitUserInstruction: "Cancel second" }, "codex");
    assert.equal(tasks.getTask(first.id).relatedTasks[0]?.status, "closed");
    tasks.deleteBacklogTask(first.id, "user");
    assert.deepEqual(tasks.getTask(second.id).relatedTasks, []);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM task_relationships").get().count, 0);
  } finally { database.close(); }
});

test("removing a relationship is bidirectional and idempotent", () => {
  const { database, tasks, project } = fixture();
  try {
    const first = tasks.createTask({ projectId: project.id, title: "First" }, "user");
    const second = tasks.createTask({ projectId: project.id, title: "Second" }, "user");
    tasks.addRelatedTask(first.id, second.id, "user");
    tasks.removeRelatedTask(second.humanId, first.humanId, "codex");
    tasks.removeRelatedTask(first.id, second.id, "codex");
    assert.deepEqual(tasks.getTask(first.id).relatedTasks, []);
    assert.deepEqual(tasks.getTask(second.id).relatedTasks, []);
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

test("persists, replaces, exposes, and removes validated project logos", () => {
  const { database, tasks, project } = fixture();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  try {
    const uploaded = tasks.uploadProjectLogo(project.id, png, "image/png", "user");
    assert.equal(uploaded.logo?.mimeType, "image/png");
    assert.equal(uploaded.logo?.size, png.length);
    assert.match(uploaded.logo?.url ?? "", new RegExp(`/api/projects/${project.id}/logo`));
    const task = tasks.createTask({ projectId: project.id, title: "Branded task" }, "user");
    assert.deepEqual(task.projectLogo, uploaded.logo);
    const firstPath = tasks.projectLogoFile(project.id).path;
    assert.equal(existsSync(firstPath), true);
    tasks.uploadProjectLogo(project.id, png, "image/png", "user");
    assert.equal(existsSync(firstPath), false);
    assert.equal(readdirSync(join(database.dataDir, "project-logos")).length, 1);
    assert.equal((tasks.exportData().projects as Array<{ logo: unknown }>)[0]?.logo !== null, true);
    tasks.removeProjectLogo(project.id, "user");
    assert.equal(tasks.listProjects()[0]?.logo, null);
    assert.throws(() => tasks.projectLogoFile(project.id), /not found/);
    assert.equal(readdirSync(join(database.dataDir, "project-logos")).length, 0);
  } finally { database.close(); }
});

test("rejects unsafe project logo content and oversized files", () => {
  const { database, tasks, project } = fixture();
  try {
    assert.throws(() => tasks.uploadProjectLogo(project.id, Buffer.from("not an image"), "image/png", "user"), /PNG, JPEG, or WebP/);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    assert.throws(() => tasks.uploadProjectLogo(project.id, jpeg, "image/png", "user"), /does not match/);
    assert.throws(() => tasks.uploadProjectLogo(project.id, Buffer.alloc(0), "image/png", "user"), /empty/);
    assert.throws(() => tasks.uploadProjectLogo(project.id, projectLogoPng(2 * 1024 * 1024 + 1), "image/png", "user"), /2 MB/);
  } finally { database.close(); }
});

test("project logo storage accepts the 2 MiB boundary and preserves it after rejection", () => {
  const { database, tasks, project } = fixture();
  try {
    for (const size of [256 * 1024 + 1, 2 * 1024 * 1024]) {
      const uploaded = tasks.uploadProjectLogo(project.id, projectLogoPng(size), "image/png", "user");
      assert.equal(uploaded.logo?.size, size);
    }
    const savedPath = tasks.projectLogoFile(project.id).path;
    assert.throws(() => tasks.uploadProjectLogo(project.id, projectLogoPng(2 * 1024 * 1024 + 1), "image/png", "user"), /2 MB/);
    assert.equal(tasks.projectLogoFile(project.id).path, savedPath);
    assert.equal(existsSync(savedPath), true);
    assert.equal(readdirSync(join(database.dataDir, "project-logos")).length, 1);
  } finally { database.close(); }
});
