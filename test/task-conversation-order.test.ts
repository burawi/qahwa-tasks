import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import type { SessionRunState } from "../src/domain/types.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-conversation-order-"));
  const database = new AppDatabase({ host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 1 });
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Sorting", prefix: "SORT", rootDirectory: root }, "user");
  const stamp = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const session = (id: string, state: SessionRunState) => database.db.prepare(`INSERT INTO agent_sessions
    (id, owner_type, owner_id, run_state, created_at, updated_at) VALUES (?, 'task', ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_id) DO UPDATE SET run_state = excluded.run_state`).run(id, id, state, stamp(1), stamp(31));
  const message = (id: string, day: number) => database.db.prepare(`INSERT INTO chat_messages
    (id, owner_type, owner_id, role, body, created_at) VALUES (?, 'task', ?, 'assistant', 'Latest reply', ?)`)
    .run(`${id}-${day}`, id, stamp(day));
  const create = (title: string, day?: number, state?: SessionRunState) => {
    const task = tasks.createTask({ projectId: project.id, title, status: "todo" }, "user");
    database.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(stamp(1), task.id);
    if (day) message(task.id, day);
    if (state) session(task.id, state);
    return task.id;
  };
  const list = () => tasks.listTasks({ tab: "active", order: "conversation" });
  return { database, tasks, project, stamp, create, session, message, list,
    ids: () => list().map(t => t.id),
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("conversation groups are pinned, running, then others, with recency within every group", () => {
  const f = fixture();
  try {
    const pinnedOld = f.create("Pinned running", 2, "running"), pinnedNew = f.create("Pinned idle", 3, "idle");
    const runningOld = f.create("Running old", 4, "running"), runningNew = f.create("Running new", 5, "running");
    const idle = f.create("In progress but idle", 10, "idle");
    f.tasks.transition(idle, { to: "in_progress" }, "user");
    const waiting = f.create("Waiting", 9, "waiting"), failed = f.create("Failed", 8, "failed");
    const interrupted = f.create("Interrupted", 7, "interrupted"), notStarted = f.create("Not started", 6, "not_started");
    const noSession = f.create("No session", 11), emptyRunning = f.create("Running without messages", undefined, "running");
    f.tasks.setPinned(pinnedOld, true); f.tasks.setPinned(pinnedNew, true);
    const queueBefore = f.tasks.listTasks({ tab: "active" });
    assert.deepEqual(f.ids(), [pinnedNew, pinnedOld, runningNew, runningOld, emptyRunning, noSession, idle, waiting, failed, interrupted, notStarted]);
    assert.deepEqual(f.tasks.listTasks({ tab: "active" }), queueBefore, "Reading the list leaves scheduling untouched");
    f.session(runningOld, "idle");
    assert.deepEqual(f.ids().slice(0, 4), [pinnedNew, pinnedOld, runningNew, emptyRunning]);
    f.session(noSession, "running");
    assert.deepEqual(f.ids().slice(0, 5), [pinnedNew, pinnedOld, noSession, runningNew, emptyRunning]);
    f.tasks.setPinned(runningNew, true);
    assert.deepEqual(f.ids().slice(0, 4), [runningNew, pinnedNew, pinnedOld, noSession]);
    f.tasks.setPinned(runningNew, false);
    f.message(pinnedOld, 20); f.message(emptyRunning, 21);
    assert.deepEqual(f.ids().slice(0, 5), [pinnedOld, pinnedNew, emptyRunning, noSession, runningNew]);
    assert.deepEqual(f.tasks.listTasks({ tab: "active" }).map(t => [t.id, t.status, t.rank]), queueBefore.map(t => [t.id, t.status, t.rank]));
    assert.equal(f.list().find(t => t.id === pinnedOld)!.conversation!.unreadCount, 2);
  } finally { f.close(); }
});

test("conversation ties retain creation time then ID, including empty tasks", () => {
  const f = fixture();
  try {
    const first = f.create("First", 5, "running"), second = f.create("Second", 5, "running");
    assert.deepEqual(f.ids(), [first, second].sort());
    f.database.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(f.stamp(2), second);
    assert.deepEqual(f.ids(), [second, first]);
    const emptyOld = f.create("Empty old"), emptyNew = f.create("Empty new");
    f.database.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(f.stamp(3), emptyNew);
    assert.deepEqual(f.ids(), [second, first, emptyNew, emptyOld]);
    f.tasks.setPinned(first, true); f.tasks.setPinned(second, true);
    assert.deepEqual(f.ids().slice(0, 2), [second, first]);
  } finally { f.close(); }
});

test("terminal sorting uses the same effective running state as its indicator", () => {
  const f = fixture();
  try {
    const terminal = f.create("Terminal", 2, "running"), idle = f.create("Newer idle", 20);
    f.database.db.prepare("UPDATE tasks SET session_kind = 'terminal' WHERE id = ?").run(terminal);
    f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('test','Test','','now','now')").run();
    f.database.db.prepare(`INSERT INTO terminal_sessions(task_id,generation,device_id,creation_key,root_directory,state,updated_at)
      VALUES (?,'generation','test','creation',?,'running',?)`).run(terminal, f.project.rootDirectory, f.stamp(2));
    assert.deepEqual(f.ids(), [terminal, idle]);
    assert.equal(f.list()[0]!.sessionState, "running");
    for (const state of ["exited", "interrupted", "failed"]) {
      f.database.db.prepare("UPDATE terminal_sessions SET state = ? WHERE task_id = ?").run(state, terminal);
      assert.deepEqual(f.ids(), [idle, terminal], `${state} terminal is not active even with a stale running agent session`);
      assert.notEqual(f.list()[1]!.sessionState, "running");
    }
    f.tasks.setPinned(terminal, true);
    assert.deepEqual(f.ids(), [terminal, idle]);
  } finally { f.close(); }
});
