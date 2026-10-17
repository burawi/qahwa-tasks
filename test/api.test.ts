import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentFromPlainText } from "../src/domain/types.js";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";

test("requires authentication and issues a persistent secure session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-api-"));
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  await new AuthService(database, 365, true).setPassword("correct horse battery staple");
  const app = await buildApp(config, database);
  try {
    const denied = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(denied.statusCode, 401);
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong password value" } });
    assert.equal(wrong.statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery staple" } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"];
    assert.match(String(cookie), /HttpOnly/);
    assert.match(String(cookie), /Secure/);
    const token = String(cookie).split(";", 1)[0];
    const allowed = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: token } });
    assert.equal(allowed.statusCode, 200);
  } finally { await app.close(); }
});

test("configures the first password through a one-use expiring setup token", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-setup-"));
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365, true);
  const { token } = auth.createSetupToken();
  const app = await buildApp(config, database);
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/auth/setup", payload: { token, password: "new secure setup password" },
    });
    assert.equal(setup.statusCode, 200);
    assert.match(String(setup.headers["set-cookie"]), /HttpOnly/);
    const reused = await app.inject({
      method: "POST", url: "/api/auth/setup", payload: { token, password: "new secure setup password" },
    });
    assert.equal(reused.statusCode, 409);
  } finally { await app.close(); }
});

test("web API records review feedback but cannot return a task to work", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-review-api-"));
  const projectRoot = join(dataDir, "project");
  mkdirSync(projectRoot);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365, true);
  await auth.setPassword("correct horse battery staple");
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Review", prefix: "REV", rootDirectory: projectRoot }, "user");
  const created = tasks.createTask({ projectId: project.id, title: "Review task", status: "todo" }, "user");
  tasks.transition(created.id, { to: "in_progress" }, "codex");
  tasks.submitForReview(created.id, { summary: "Ready" }, "codex");
  const app = await buildApp(config, database);
  try {
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery staple" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const detail = await app.inject({ method: "GET", url: `/api/tasks/${created.id}`, headers: { cookie } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().task.outputs[0].summary, "Ready");
    assert.equal(detail.json().task.comments.length, 0);
    const feedback = await app.inject({
      method: "POST", url: `/api/tasks/${created.id}/comments`, headers: { cookie },
      payload: { body: documentFromPlainText("Please adjust spacing") },
    });
    assert.equal(feedback.statusCode, 201);
    assert.equal(tasks.getTask(created.id).status, "in_review");
    const transition = await app.inject({
      method: "POST", url: `/api/tasks/${created.id}/transition`, headers: { cookie }, payload: { to: "in_progress" },
    });
    assert.equal(transition.statusCode, 409);
    assert.equal(transition.json().message, "Only Codex can return an in-review task to work");
    assert.equal(tasks.getTask(created.id).status, "in_review");
    const completed = await app.inject({
      method: "POST", url: `/api/tasks/${created.id}/transition`, headers: { cookie },
      payload: { to: "closed", outcome: "completed" },
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().task.outcome, "completed");
  } finally { await app.close(); }
});

test("project logo API authenticates, validates, and serves uploaded images", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-logo-api-"));
  const projectRoot = join(dataDir, "project");
  mkdirSync(projectRoot);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  await new AuthService(database, 365, true).setPassword("correct horse battery staple");
  const project = new TaskService(database).createProject({ name: "Logo API", prefix: "LOG", rootDirectory: projectRoot }, "user");
  const app = await buildApp(config, database);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  try {
    const denied = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/logo`, headers: { "content-type": "image/png" }, payload: png });
    assert.equal(denied.statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery staple" } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const mismatch = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/logo`, headers: { cookie, "content-type": "image/jpeg" }, payload: png,
    });
    assert.equal(mismatch.statusCode, 400);
    assert.match(mismatch.json().message, /does not match/);
    const uploaded = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/logo`, headers: { cookie, "content-type": "image/png" }, payload: png,
    });
    assert.equal(uploaded.statusCode, 200);
    assert.equal(uploaded.json().project.logo.mimeType, "image/png");
    const fetched = await app.inject({ method: "GET", url: `/api/projects/${project.id}/logo`, headers: { cookie } });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.headers["content-type"], "image/png");
    assert.deepEqual(fetched.rawPayload, png);
    const oversized = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/logo`, headers: { cookie, "content-type": "image/png" }, payload: Buffer.alloc(256 * 1024 + 1),
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().message, "Logo must be 256 KB or smaller");
    const removed = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}/logo`, headers: { cookie } });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().project.logo, null);
  } finally { await app.close(); }
});
