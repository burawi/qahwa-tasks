import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { documentFromPlainText } from "../src/domain/types.js";
import { fallbackTaskTitle } from "../src/domain/task-title.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { TaskTitleService, type TaskTitleGenerator } from "../src/server/task-title-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import { TaskCard } from "../src/web/components/TaskCard.js";

function fixture(t: test.TestContext, generate: TaskTitleGenerator = async () => JSON.stringify({ title: "Simplify mobile order entry" }), timeoutMs?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-task-titles-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir, backupDir: join(dataDir, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Titles", prefix: "TTL", rootDirectory: dataDir }, "user");
  const titles = new TaskTitleService(database, tasks, generate, timeoutMs);
  t.after(async () => { await titles.close(); if (database.db.open) database.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const create = (note = "The mobile order entry form is confusing. Make entering an order simpler.") => tasks.createTask({ projectId: project.id, description: documentFromPlainText(note) }, "user");
  const job = (id: string) => database.db.prepare("SELECT * FROM task_title_jobs WHERE task_id = ?").get(id) as { state: string; attempts: number; origin: string } | undefined;
  return { config, database, tasks, project, titles, create, job };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

test("quick capture saves immediately, generates from the full note and displays the saved title", async t => {
  const result = deferred<string>();
  let received = "";
  const f = fixture(t, async note => { received = note; return result.promise; });
  const note = "The mobile order form needs attention.\nMake phone entry simpler and preserve the selected items.";
  const task = f.create(note);
  const original = f.tasks.getTask(task.id);
  assert.equal(original.title, fallbackTaskTitle(note));
  assert.equal(f.job(task.id)?.state, "pending");
  assert.equal(f.job(task.id)?.origin, "new_task");
  const work = f.titles.runNext();
  assert.equal(received, note);
  assert.equal(f.tasks.getTask(task.id).title, original.title, "Creation remains usable during generation");
  result.resolve(JSON.stringify({ title: "Simplify mobile order entry" }));
  await work;
  const saved = f.tasks.getTask(task.id);
  assert.equal(saved.title, "Simplify mobile order entry");
  assert.deepEqual(saved.description, original.description);
  assert.equal(saved.status, "backlog");
  assert.equal(saved.rank, original.rank);
  assert.equal(saved.sessionState, "not_started");
  assert.equal(saved.version, 2);
  assert.equal(f.job(task.id)?.state, "generated");
  const html = renderToStaticMarkup(React.createElement(TaskCard, { task: f.tasks.listTasks()[0]!, onOpen() {} }));
  assert.match(html, /class="conversation-title" dir="auto">Simplify mobile order entry</);
  assert.doesNotMatch(html, /The mobile order form needs attention/);
  assert.equal((f.database.db.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as { count: number }).count, 0);
  assert.equal(await f.titles.runNext(), false, "Generated jobs are not duplicated");
});

test("explicit titles, including exact fallback matches, are never queued", async t => {
  const f = fixture(t, async () => { throw new Error("Should never call Codex"); });
  for (const title of ["My deliberate title", "The note"]) {
    const task = f.tasks.createTask({ projectId: f.project.id, title, description: documentFromPlainText("The note") }, "user");
    assert.equal(f.job(task.id), undefined);
    assert.equal(f.tasks.getTask(task.id).title, title);
  }
  assert.equal(await f.titles.runNext(), false);
  assert.throws(() => f.tasks.createTask({ projectId: f.project.id, title: "" }, "user"), /Title must/);
  assert.throws(() => f.tasks.createTask({ projectId: f.project.id }, "user"), /Title must/);
});

test("manual title edits and even restoring the fallback defeat an in-flight result", async t => {
  for (const restore of [false, true]) {
    const result = deferred<string>();
    const f = fixture(t, () => result.promise);
    const task = f.create();
    const work = f.titles.runNext();
    const manual = f.tasks.updateTask(task.id, { title: "Keep my wording", expectedVersion: 1 }, "user");
    if (restore) f.tasks.updateTask(task.id, { title: task.title, expectedVersion: manual.version }, "user");
    result.resolve(JSON.stringify({ title: "Unwanted generated title" }));
    await work;
    assert.equal(f.tasks.getTask(task.id).title, restore ? task.title : "Keep my wording");
    assert.equal(f.job(task.id)?.state, "skipped");
  }
});

test("saving the same title explicitly before generation protects manual intent", async t => {
  let called = false;
  const f = fixture(t, async () => { called = true; return '{"title":"Wrong"}'; });
  const task = f.create();
  f.tasks.updateTask(task.id, { title: task.title, expectedVersion: 1 }, "user");
  await f.titles.runNext();
  assert.equal(called, false);
  assert.equal(f.tasks.getTask(task.id).title, task.title);
  assert.equal(f.job(task.id)?.state, "skipped");
});

test("description edits, closure and deletion during generation cannot receive stale titles", async t => {
  for (const change of ["description", "close", "delete"] as const) {
    const result = deferred<string>();
    const f = fixture(t, () => result.promise);
    const task = f.create();
    const work = f.titles.runNext();
    if (change === "description") f.tasks.updateTask(task.id, { description: documentFromPlainText("An entirely different task"), expectedVersion: 1 }, "user");
    if (change === "close") {
      f.tasks.transition(task.id, { to: "todo" }, "user");
      f.tasks.transition(task.id, { to: "closed", outcome: "cancelled" }, "user");
    }
    if (change === "delete") f.tasks.deleteBacklogTask(task.id, "user");
    result.resolve('{"title":"Stale title"}');
    await work;
    if (change === "delete") assert.equal(f.job(task.id), undefined);
    else {
      assert.equal(f.tasks.getTask(task.id).title, task.title);
      assert.equal(f.job(task.id)?.state, "skipped");
    }
  }
});

test("model failures and malformed output preserve fallback and description without retry loops", async t => {
  for (const output of [null, "invalid json", '{"title":""}', '{"title":123}', JSON.stringify({ title: "a".repeat(101) }), JSON.stringify({ title: "Two\nlines" }), '{"title":"<script>"}']) {
    const f = fixture(t, async () => { if (output === null) throw new Error("Unavailable"); return output; });
    const task = f.create();
    await f.titles.runNext();
    assert.equal(f.tasks.getTask(task.id).title, task.title);
    assert.deepEqual(f.tasks.getTask(task.id).description, task.description);
    assert.equal(f.job(task.id)?.state, "failed");
    assert.equal(await f.titles.runNext(), false);
  }
});

test("timeout and shutdown abort only the title job and prevent late writes", async t => {
  for (const shutdown of [false, true]) {
    const result = deferred<string>();
    let signal!: AbortSignal;
    const f = fixture(t, async (_note, abort) => { signal = abort; return result.promise; }, shutdown ? 10_000 : 5);
    const task = f.create();
    const work = f.titles.runNext();
    if (shutdown) await f.titles.close();
    await work;
    assert.equal(signal.aborted, true);
    result.resolve('{"title":"Too late"}');
    await Promise.resolve();
    assert.equal(f.tasks.getTask(task.id).title, task.title);
    assert.equal(f.job(task.id)?.state, shutdown ? "pending" : "failed");
  }
});

test("concurrent workers use durable claims and only one generates a given title", async t => {
  const result = deferred<string>();
  let calls = 0;
  const f = fixture(t, async () => { calls++; return result.promise; });
  const task = f.create();
  const otherDb = new AppDatabase(f.config);
  const other = new TaskTitleService(otherDb, new TaskService(otherDb), async () => { calls++; return '{"title":"Duplicate"}'; });
  const work = f.titles.runNext();
  assert.equal(await other.runNext(), false);
  assert.equal(f.titles.runNext(), work);
  result.resolve('{"title":"One title"}');
  await work;
  assert.equal(calls, 1);
  assert.equal(f.job(task.id)?.attempts, 1);
  await other.close(); otherDb.close();
});

test("expired restart claims are bounded and old claim results cannot overwrite replacements", async t => {
  const result = deferred<string>();
  const f = fixture(t, () => result.promise);
  const task = f.create();
  const work = f.titles.runNext();
  f.database.db.prepare("UPDATE task_title_jobs SET lease_until = '2000-01-01' WHERE task_id = ?").run(task.id);
  const other = new TaskTitleService(f.database, f.tasks, async () => '{"title":"Recovered title"}');
  await other.runNext();
  result.resolve('{"title":"Old claim"}');
  await work;
  assert.equal(f.tasks.getTask(task.id).title, "Recovered title");
  assert.equal(f.job(task.id)?.attempts, 2);
  const exhausted = f.create();
  f.database.db.prepare("UPDATE task_title_jobs SET state = 'running', attempts = 3, lease_until = '2000-01-01' WHERE task_id = ?").run(exhausted.id);
  assert.equal(await other.runNext(), false);
  assert.equal(f.job(exhausted.id)?.state, "failed");
  await other.close();
});

test("legacy eligibility requires the exact old truncation signature and untouched user history", async t => {
  const f = fixture(t);
  const note = "Please investigate the mobile order creation form and make a proposal that keeps the existing behavior while reducing the amount of typing.";
  const legacy = (text = note, actor: "user" | "codex" = "user") => {
    const task = f.tasks.createTask({ projectId: f.project.id, title: fallbackTaskTitle(text), description: documentFromPlainText(text) }, actor);
    f.database.db.prepare("UPDATE tasks SET title_source = 'unknown' WHERE id = ?").run(task.id);
    return task;
  };
  const eligible = legacy();
  const short = legacy("A short intentional title");
  const manual = legacy();
  f.tasks.updateTask(manual.id, { title: "Manual title", expectedVersion: 1 }, "user");
  f.tasks.updateTask(manual.id, { title: manual.title, expectedVersion: 2 }, "user");
  const edited = legacy();
  f.tasks.updateTask(edited.id, { description: documentFromPlainText("Changed note"), expectedVersion: 1 }, "user");
  const codex = legacy(note, "codex");
  const missing = legacy();
  f.database.db.prepare("DELETE FROM task_versions WHERE task_id = ?").run(missing.id);
  const closed = legacy();
  f.tasks.transition(closed.id, { to: "todo" }, "user");
  f.tasks.transition(closed.id, { to: "closed", outcome: "cancelled" }, "user");
  const explicit = f.tasks.createTask({ projectId: f.project.id, title: fallbackTaskTitle(note), description: documentFromPlainText(note) }, "user");
  const selected = [eligible, short, manual, edited, codex, missing, closed, explicit].map(task => task.id);
  assert.equal(f.titles.requestBackfill(selected), 1);
  assert.equal(f.titles.requestBackfill(selected), 0);
  for (const preserved of [short, manual, edited, codex, missing, closed, explicit]) assert.equal(f.job(preserved.id), undefined);
  await f.titles.runNext();
  assert.equal(f.job(eligible.id)?.state, "generated");
  assert.deepEqual(f.tasks.getTask(eligible.id).description, eligible.description);
});

test("titles in the description language flow through the list without changing the note", async t => {
  const f = fixture(t, async () => JSON.stringify({ title: "تبسيط إدخال الطلبات" }));
  const task = f.create("نحب نسهل إدخال الطلبات في التليفون ونخلي المنتوجات المختارة كيما هي");
  await f.titles.runNext();
  assert.equal(f.tasks.listTasks()[0]?.title, "تبسيط إدخال الطلبات");
  assert.deepEqual(f.tasks.getTask(task.id).description, task.description);
});

test("HTTP note capture returns a fallback, then polling reads the persisted generated title", async t => {
  const f = fixture(t);
  f.database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', 'now', 'now')").run();
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  let calls = 0;
  const app = await buildApp(f.config, f.database, { generateTitle: async () => { calls++; return '{"title":"Clarify mobile orders"}'; } });
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  try {
    const response = await app.inject({ method: "POST", url: "/api/tasks", headers, payload: { projectId: f.project.id, description: documentFromPlainText("Please make mobile order entry easier") } });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().task.title, "Please make mobile order entry easier");
    assert.equal(calls, 0);
    await new Promise(resolve => setTimeout(resolve, 2_100));
    const list = await app.inject({ method: "GET", url: "/api/tasks", headers });
    assert.equal(list.json().tasks[0].title, "Clarify mobile orders");
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

const legacyNote = "Please investigate the mobile order creation form and make a proposal that keeps the existing behavior while reducing the amount of typing.";

function legacyTask(f: ReturnType<typeof fixture>, note = legacyNote) {
  const task = f.tasks.createTask({ projectId: f.project.id, title: fallbackTaskTitle(note), description: documentFromPlainText(note) }, "user");
  f.database.db.prepare("UPDATE tasks SET title_source = 'unknown' WHERE id = ?").run(task.id);
  return task;
}

test("ordinary startup and restart never enroll existing tasks, while saved new-task jobs survive restart", async t => {
  const f = fixture(t);
  const existing = legacyTask(f);
  f.titles.start();
  assert.equal(f.job(existing.id), undefined);
  assert.equal(await f.titles.runNext(), false);
  const captured = f.create();
  await f.titles.close();
  f.database.close();
  const reopened = new AppDatabase(f.config);
  const tasks = new TaskService(reopened);
  let calls = 0;
  const restarted = new TaskTitleService(reopened, tasks, async () => { calls++; return '{"title":"A new capture title"}'; });
  try {
    restarted.start();
    assert.equal(reopened.db.prepare("SELECT * FROM task_title_jobs WHERE task_id = ?").get(existing.id), undefined);
    assert.equal(await restarted.runNext(), true);
    assert.equal(tasks.getTask(captured.id).title, "A new capture title");
    assert.equal(tasks.getTask(existing.id).title, existing.title);
    assert.equal(await restarted.runNext(), false);
    assert.equal(calls, 1);
  } finally { await restarted.close(); reopened.close(); }
});

test("migration leaves previously queued backfill unclassified and unclaimed, even with expired leases", async t => {
  const f = fixture(t);
  const pending = legacyTask(f), expired = legacyTask(f), active = legacyTask(f), uncertain = legacyTask(f, "A short title");
  for (const task of [pending, expired, active, uncertain]) {
    f.database.db.prepare(`INSERT INTO task_title_jobs
      (task_id,source_version,source_title,description_json,state,claim_token,lease_until,created_at,updated_at)
      VALUES (?,1,?,?,'pending',NULL,NULL,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z')`)
      .run(task.id, task.title, JSON.stringify(task.description));
    f.database.db.prepare("UPDATE tasks SET title_source = 'fallback' WHERE id = ?").run(task.id);
  }
  f.database.db.prepare("UPDATE task_title_jobs SET state = 'running', claim_token = 'expired-old-claim', lease_until = '2000-01-01', attempts = 1 WHERE task_id = ?").run(expired.id);
  f.database.db.prepare("UPDATE task_title_jobs SET state = 'running', claim_token = 'active-old-claim', lease_until = '2999-01-01', attempts = 1 WHERE task_id = ?").run(active.id);
  // Reproduce the deployed table without provenance; only this isolated fixture is changed.
  f.database.db.exec("ALTER TABLE task_title_jobs DROP COLUMN origin");
  const before = f.database.db.prepare("SELECT * FROM task_title_jobs ORDER BY task_id").all();
  f.database.close();
  const reopened = new AppDatabase(f.config);
  const tasks = new TaskService(reopened);
  let calls = 0;
  const restarted = new TaskTitleService(reopened, tasks, async () => { calls++; return '{"title":"Explicitly selected title"}'; });
  try {
    restarted.start();
    assert.equal(await restarted.runNext(), false);
    const after = reopened.db.prepare("SELECT * FROM task_title_jobs ORDER BY task_id").all() as Array<Record<string, unknown>>;
    assert.ok(after.every(row => row.origin === "unclassified"));
    assert.deepEqual(after.map(({ origin: _origin, ...row }) => row), before, "Startup does not reclaim, fail or reset unapproved jobs");
    const captured = tasks.createTask({ projectId: f.project.id, description: documentFromPlainText("A new note after migration") }, "user");
    assert.equal(await restarted.runNext(), true);
    assert.equal(tasks.getTask(captured.id).title, "Explicitly selected title");
    assert.equal(calls, 1, "Unclassified jobs do not block or consume new-task generation");
    assert.equal(restarted.requestBackfill([pending.humanId, pending.id, active.id, uncertain.id]), 1);
    assert.equal(restarted.requestBackfill([pending.id]), 0, "Repeated opt-in does not duplicate a job");
    assert.equal(await restarted.runNext(), true);
    assert.equal(tasks.getTask(pending.id).title, "Explicitly selected title");
    assert.equal(tasks.getTask(expired.id).title, expired.title);
    assert.equal(tasks.getTask(active.id).title, active.title);
    assert.equal(tasks.getTask(uncertain.id).title, uncertain.title);
    assert.equal(restarted.requestBackfill([expired.id]), 1, "Expired legacy claims need an explicit opt-in too");
    assert.equal(await restarted.runNext(), true);
    assert.equal(tasks.getTask(expired.id).title, "Explicitly selected title");
    const job = reopened.db.prepare("SELECT * FROM task_title_jobs WHERE task_id = ?").get(expired.id) as { origin: string; state: string; attempts: number; claim_token: string | null };
    assert.deepEqual({ origin: job.origin, state: job.state, attempts: job.attempts, claim_token: job.claim_token }, { origin: "backfill", state: "generated", attempts: 2, claim_token: null });
  } finally { await restarted.close(); reopened.close(); }
});

test("unclassified queue entries with stale snapshots or manual edits cannot be opted in", async t => {
  const f = fixture(t);
  const stale = legacyTask(f), edited = legacyTask(f);
  for (const task of [stale, edited]) {
    f.database.db.prepare(`INSERT INTO task_title_jobs
      (task_id,source_version,source_title,description_json,created_at,updated_at) VALUES (?,1,?,?,'old','old')`)
      .run(task.id, task.title, JSON.stringify(task.description));
  }
  f.database.db.prepare("UPDATE task_title_jobs SET source_title = 'Different snapshot' WHERE task_id = ?").run(stale.id);
  f.tasks.updateTask(edited.id, { title: "My manual title", expectedVersion: 1 }, "user");
  assert.equal(f.titles.requestBackfill([stale.id, edited.id]), 0);
  assert.equal(await f.titles.runNext(), false);
  assert.equal(f.tasks.getTask(edited.id).title, "My manual title");
});

test("explicit selected backfill authorization survives restart without enrolling other existing tasks", async t => {
  const f = fixture(t);
  const selected = legacyTask(f), unselected = legacyTask(f);
  assert.equal(f.titles.requestBackfill([selected.id]), 1);
  await f.titles.close(); f.database.close();
  const reopened = new AppDatabase(f.config);
  const tasks = new TaskService(reopened);
  const restarted = new TaskTitleService(reopened, tasks, async () => '{"title":"Authorized before restart"}');
  try {
    restarted.start();
    await restarted.runNext();
    assert.equal(tasks.getTask(selected.id).title, "Authorized before restart");
    assert.equal(tasks.getTask(unselected.id).title, unselected.title);
    assert.equal(reopened.db.prepare("SELECT * FROM task_title_jobs WHERE task_id = ?").get(unselected.id), undefined);
    assert.equal(await restarted.runNext(), false);
  } finally { await restarted.close(); reopened.close(); }
});

test("backfill HTTP operation requires authentication and an explicit valid task selection", async t => {
  const f = fixture(t);
  const first = legacyTask(f), unselected = legacyTask(f);
  f.database.db.prepare("INSERT INTO paired_devices (id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','','now','now')").run();
  const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "device").token;
  const app = await buildApp(f.config, f.database, { generateTitle: async () => '{"title":"Explicit backfill"}' });
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  const url = "/api/task-titles/backfill";
  try {
    assert.equal((await app.inject({ method: "POST", url, payload: { taskIds: [first.id] } })).statusCode, 401);
    for (const payload of [{}, { taskIds: [] }, { taskIds: "all" }, { taskIds: [null] }]) {
      assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 400);
    }
    const unknown = await app.inject({ method: "POST", url, headers, payload: { taskIds: [first.id, "missing-task"] } });
    assert.equal(unknown.statusCode, 404);
    assert.equal(f.job(first.id), undefined, "An invalid selection enrolls nothing");
    const selected = await app.inject({ method: "POST", url, headers, payload: { taskIds: [first.humanId, first.id] } });
    assert.equal(selected.statusCode, 200);
    assert.deepEqual(selected.json(), { enrolled: 1 });
    assert.equal(f.job(first.id)?.origin, "backfill");
    assert.equal(f.job(unselected.id), undefined);
    assert.equal(f.tasks.getTask(first.id).title, first.title, "Opt-in itself does not rename synchronously");
  } finally { await app.close(); }
});
