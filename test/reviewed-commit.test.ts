import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { plainTextFromDocument } from "../src/domain/types.js";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-commit-test-"));
  const root = join(dataDir, "project");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Qahwa Test");
  git(root, "config", "user.email", "qahwa@example.com");
  writeFileSync(join(root, "reviewed.txt"), "original\n");
  writeFileSync(join(root, "staged.txt"), "original\n");
  writeFileSync(join(root, "dirty.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Commit project", prefix: "COM", rootDirectory: root }, "user");
  return { config, database, tasks, project, root };
}

function submit(tasks: TaskService, projectId: string, root: string, title: string, releaseNote: string) {
  const task = tasks.createTask({ projectId, title, status: "todo" }, "user");
  tasks.transition(task.id, { to: "in_progress" }, "codex");
  return tasks.submitForReview(task.id, {
    summary: "Reviewed implementation",
    commitProposal: {
      message: `feat: ${title.toLowerCase()}`,
      repositoryRoot: root,
      baseRevision: git(root, "rev-parse", "HEAD"),
      files: ["reviewed.txt"],
      releaseNote,
    },
  }, "codex");
}

test("approval commits only the stable reviewed scope and accumulates one publish Todo", () => {
  const { database, tasks, project, root } = fixture();
  try {
    writeFileSync(join(root, "reviewed.txt"), "reviewed one\n");
    writeFileSync(join(root, "staged.txt"), "staged unrelated\n");
    git(root, "add", "staged.txt");
    writeFileSync(join(root, "dirty.txt"), "dirty unrelated\n");
    const first = submit(tasks, project.id, root, "First", "Release first reviewed change");
    const outputId = first.outputs[0]!.id;
    assert.equal(first.outputs[0]?.commitApproval?.status, "pending");

    writeFileSync(join(root, "reviewed.txt"), "drifted\n");
    assert.throws(() => tasks.approveOutputCommit(first.id, outputId, "user"), /changed since review/);
    assert.equal(git(root, "rev-parse", "HEAD"), first.outputs[0]?.commitApproval?.baseRevision);
    writeFileSync(join(root, "reviewed.txt"), "reviewed one\n");

    const approved = tasks.approveOutputCommit(first.id, outputId, "user");
    const commit = approved.outputs[0]?.commitApproval?.commitHash;
    assert.match(commit ?? "", /^[0-9a-f]{40}$/);
    assert.equal(approved.outputs[0]?.commit, commit);
    assert.deepEqual(git(root, "show", "--pretty=", "--name-only", commit!).split("\n").filter(Boolean), ["reviewed.txt"]);
    assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "staged unrelated\n");
    assert.equal(git(root, "diff", "--cached", "--name-only"), "staged.txt");
    assert.equal(git(root, "diff", "--name-only"), "dirty.txt");

    const todos = tasks.listTasks({ tab: "todo", projectId: project.id }).filter((task) => task.title === "Publish/deploy changes");
    assert.equal(todos.length, 1);
    let publish = tasks.getTask(todos[0]!.id);
    assert.match(plainTextFromDocument(publish.description), new RegExp(commit!));
    assert.deepEqual(approved.relatedTasks.map((task) => task.humanId), [publish.humanId]);

    const head = git(root, "rev-parse", "HEAD");
    tasks.approveOutputCommit(first.id, outputId, "user");
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal((plainTextFromDocument(tasks.getTask(publish.id).description).match(new RegExp(commit!, "g")) ?? []).length, 1);

    writeFileSync(join(root, "reviewed.txt"), "reviewed two\n");
    const second = submit(tasks, project.id, root, "Second", "Release second reviewed change");
    tasks.approveOutputCommit(second.id, second.outputs[0]!.id, "user");
    publish = tasks.getTask(publish.id);
    assert.equal(tasks.listTasks({ tab: "todo", projectId: project.id }).filter((task) => task.title === "Publish/deploy changes").length, 1);
    assert.match(plainTextFromDocument(publish.description), /Release first reviewed change/);
    assert.match(plainTextFromDocument(publish.description), /Release second reviewed change/);
    assert.deepEqual(publish.relatedTasks.map((task) => task.humanId).sort(), [first.humanId, second.humanId].sort());
  } finally { database.close(); }
});

test("approval refuses processing races and duplicate active publish tasks before committing", () => {
  const { database, tasks, project, root } = fixture();
  try {
    writeFileSync(join(root, "reviewed.txt"), "reviewed\n");
    const task = submit(tasks, project.id, root, "Race", "Race-safe release");
    const output = task.outputs[0]!;
    database.db.prepare("UPDATE task_outputs SET commit_approval_status = 'processing' WHERE id = ?").run(output.id);
    assert.throws(() => tasks.approveOutputCommit(task.id, output.id, "user"), /already being processed/);
    database.db.prepare("UPDATE task_outputs SET commit_approval_status = 'pending' WHERE id = ?").run(output.id);
    tasks.createTask({ projectId: project.id, title: "Publish/deploy changes", status: "todo" }, "user");
    tasks.createTask({ projectId: project.id, title: "Publish/deploy changes", status: "todo" }, "user");
    const before = git(root, "rev-parse", "HEAD");
    assert.throws(() => tasks.approveOutputCommit(task.id, output.id, "user"), /multiple active publish\/deploy tasks/);
    assert.equal(git(root, "rev-parse", "HEAD"), before);
  } finally { database.close(); }
});

test("commit approval endpoint requires an authenticated user session", async () => {
  const { config, database, tasks, project, root } = fixture();
  await new AuthService(database, 365, true).setPassword("correct horse battery staple");
  writeFileSync(join(root, "reviewed.txt"), "reviewed\n");
  const task = submit(tasks, project.id, root, "Authorized", "Authorized release");
  const path = `/api/tasks/${task.id}/outputs/${task.outputs[0]!.id}/approve-commit`;
  const app = await buildApp(config, database);
  try {
    assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery staple" } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const approved = await app.inject({ method: "POST", url: path, headers: { cookie } });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().task.outputs[0].commitApproval.status, "committed");
  } finally { await app.close(); }
});
