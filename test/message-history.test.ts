import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { buildApp } from "../src/server/app.js";
import { TaskService } from "../src/server/task-service.js";
import { AgentService } from "../src/server/agent-service.js";
import { AuthService } from "../src/server/auth.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { reconcileHistory, mergeWorkspaceTail } from "../src/web/workspace-state.js";
import { workspacePoll } from "../src/server/workspace-poll.js";
import type { MessagePageQuery } from "../src/domain/types.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-history-"));
  const config = { host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backup"), sessionDays: 365 };
  const database = new AppDatabase(config), tasks = new TaskService(database);
  const project = tasks.createProject({ name: "History", prefix: "HIST", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "History", status: "todo" }, "user");
  const attachments = new AttachmentService(database), agents = new AgentService(database, tasks, attachments);
  const insert = database.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at) VALUES (?,?,?,'assistant',?,?,?)");
  const stamp = "2026-10-30T12:00:00.000Z";
  database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('test','Test','',?,?)").run(stamp, stamp);
  return { root, config, database, tasks, task, agents,
    seed(type: "task" | "orchestrator", count: number, start = 0) {
      database.db.transaction(() => {
        for (let i = start; i < start + count; i++) {
          insert.run(`${type}-${i}`, type, type === "task" ? task.id : "main", `Message ${i}`, null, stamp);
          // Lots of hidden rows must never underfill or displace the visible page.
          insert.run(`${type}-hidden-${i}`, type, type === "task" ? task.id : "main", "hidden", '{"queueScheduling":true}', stamp);
        }
      })();
    },
    close() { agents.close(); attachments.close(); database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const mode of ["task", "orchestrator"] as const) {
  test(`${mode}: latest 50 and stable older pages retain every tied-timestamp message`, () => {
    const f = fixture();
    try {
      const owner = mode === "task" ? f.task.humanId : "main";
      assert.equal(f.agents.workspace(mode, owner).messages.length, 0);
      f.seed(mode, 137);
      const initial = f.agents.workspace(mode, owner);
      assert.equal(initial.messages.length, 50);
      assert.equal(initial.messages[0]!.id, `${mode}-87`);
      assert.equal(initial.messages.at(-1)!.id, `${mode}-136`);
      assert.equal(initial.history?.hasOlder, true);
      const next = f.agents.messagePage(mode, owner, { before: initial.history!.oldestCursor! });
      assert.equal(next.messages.length, 50);
      // Concurrent inserts do not move the older page boundary.
      f.seed(mode, 80, 137);
      assert.deepEqual(f.agents.messagePage(mode, owner, { before: initial.history!.oldestCursor! }), next);
      const last = f.agents.messagePage(mode, owner, { before: next.oldestCursor! });
      assert.equal(last.messages.length, 37); assert.equal(last.hasOlder, false);
      const ids = [...last.messages, ...next.messages, ...initial.messages].map(m => m.id);
      assert.deepEqual(ids, Array.from({ length: 137 }, (_, i) => `${mode}-${i}`));
      assert.equal(new Set(ids).size, 137);
      assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE owner_type=?").get(mode)?.n, 434);
      const other = mode === "task" ? "orchestrator" : "task";
      assert.throws(() => f.agents.messagePage(other, other === "task" ? f.task.id : "main", { before: next.oldestCursor! }), /Invalid.*cursor/);
      for (const before of ["!", "", "a".repeat(3000), "W10", [next.oldestCursor]] as any[]) {
        assert.throws(() => f.agents.messagePage(mode, owner, { before }), /Invalid.*cursor/);
      }
      const plan = f.database.db.prepare(`EXPLAIN QUERY PLAN SELECT m.id FROM chat_messages m
        WHERE m.owner_type=? AND m.owner_id=? AND json_type(m.metadata_json, '$.queueScheduling') IS NOT 'true'
        AND (m.created_at,m.rowid) < (?,?) ORDER BY m.created_at DESC,m.rowid DESC LIMIT 51`)
        .all(mode, mode === "task" ? f.task.id : "main", "z", 1000);
      assert.match(JSON.stringify(plan), /idx_chat_messages_visible_owner/);
      assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
    } finally { f.close(); }
  });

  test(`${mode}: polling catches bursts, older edits, deletions, retries and resets`, async () => {
    const f = fixture();
    try {
      f.seed(mode, 150);
      const owner = mode === "task" ? f.task.id : "main";
      const initial = f.agents.workspace(mode, owner);
      const older = f.agents.messagePage(mode, owner, { before: initial.history!.oldestCursor! });
      const loaded = { ...initial, messages: [...older.messages, ...initial.messages], history: { oldestCursor: older.oldestCursor, hasOlder: older.hasOlder } };
      f.seed(mode, 123, 150);
      f.database.db.prepare("UPDATE chat_messages SET body='Changed older entry' WHERE id=?").run(`${mode}-60`);
      f.database.db.prepare("DELETE FROM chat_messages WHERE id=?").run(`${mode}-70`);
      const queries: MessagePageQuery[] = [];
      const fetch = async (query: MessagePageQuery) => { queries.push(query); const p = f.agents.messagePage(mode, owner, query); assert.ok(p.messages.length <= 50); return p; };
      const latest = f.agents.workspace(mode, owner);
      assert.deepEqual(mergeWorkspaceTail(loaded, latest).messages, loaded.messages, "Disjoint mutation tails wait for catch-up rather than introducing a gap");
      const result = await reconcileHistory(latest, loaded.history.oldestCursor, fetch, () => true);
      assert.ok(result);
      assert.equal(result.messages.length, 222);
      assert.equal(new Set(result.messages.map(m => m.id)).size, 222);
      assert.equal(result.messages[0]!.id, `${mode}-50`);
      assert.equal(result.messages.at(-1)!.id, `${mode}-272`);
      assert.equal(result.messages.find(m => m.id === `${mode}-60`)!.body, "Changed older entry");
      assert.equal(queries.length, 4);
      assert.equal(result.history?.oldestCursor, loaded.history.oldestCursor);
      assert.equal((await reconcileHistory(latest, loaded.history.oldestCursor, fetch, () => false)), null);
      await assert.rejects(reconcileHistory(latest, loaded.history.oldestCursor, async () => { throw new Error("Offline"); }, () => true), /Offline/);
      // The retry is based on the same boundary and yields the same ordered range.
      assert.deepEqual((await reconcileHistory(latest, loaded.history.oldestCursor, fetch, () => true))?.messages, result.messages);
      // Saved mutation responses retain older loaded entries.
      assert.equal(mergeWorkspaceTail(result, latest).messages.length, result.messages.length);
      assert.deepEqual(mergeWorkspaceTail(result, initial).messages.map(m => m.id), result.messages.map(m => m.id), "Delayed mutation tails cannot remove newer messages");
      const revision = workspacePoll(latest, {});
      assert.equal(workspacePoll(f.agents.workspace(mode, owner), revision).workspace, null);
      f.database.db.prepare("DELETE FROM chat_messages WHERE id=?").run(`${mode}-50`);
      const deleted = await reconcileHistory(latest, loaded.history.oldestCursor, fetch, () => true);
      assert.equal(deleted?.messages[0]!.id, `${mode}-51`);
      f.database.db.prepare("DELETE FROM chat_messages WHERE owner_type=?").run(mode);
      const empty = f.agents.workspace(mode, owner);
      assert.deepEqual((await reconcileHistory(empty, loaded.history.oldestCursor, fetch, () => true))?.messages, []);
    } finally { f.close(); }
  });
}

test("authenticated routes bound initial/poll reads, decorate history and reject foreign cursors", async () => {
  const f = fixture();
  // Avoid host-dependent capacity and model work in an isolated server.
  const app = await buildApp(f.config, f.database);
  try {
    f.seed("task", 122); f.seed("orchestrator", 122);
    const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "test").token;
    const headers = { authorization: `Bearer ${token}` };
    const paths = [`/api/tasks/${f.task.humanId}/workspace`, "/api/orchestrator"];
    for (const path of paths) {
      const response = await app.inject({ method: "GET", url: path, headers });
      assert.equal(response.statusCode, 200, response.body);
      const workspace = response.json().workspace;
      assert.equal(workspace.messages.length, 50);
      const messagePath = path.endsWith("/workspace") ? path.replace(/\/workspace$/, "/messages") : `${path}/messages`;
      assert.equal((await app.inject({ method: "GET", url: messagePath })).statusCode, 401);
      const older = await app.inject({ method: "GET", url: `${messagePath}?before=${workspace.history.oldestCursor}`, headers });
      assert.equal(older.statusCode, 200, older.body);
      assert.equal(older.json().page.messages.length, 50);
      const invalid = await app.inject({ method: "GET", url: `${messagePath}?before=invalid`, headers });
      assert.equal(invalid.statusCode, 400);
      const poll = await app.inject({ method: "GET", url: `${path}?poll=1`, headers });
      assert.equal(poll.json().workspace.messages.length, 50);
    }
  } finally { await app.close(); f.close(); }
});

test("empty, exact and partial page boundaries remain bounded", () => {
  const f = fixture();
  try {
    for (const n of [0, 1, 49, 50, 51, 100]) {
      f.database.db.prepare("DELETE FROM chat_messages").run(); f.seed("task", n);
      const workspace = f.agents.workspace("task", f.task.id);
      assert.equal(workspace.messages.length, Math.min(n, 50));
      assert.equal(workspace.history?.hasOlder, n > 50);
      if (n) {
        const older = f.agents.messagePage("task", f.task.id, { before: workspace.history!.oldestCursor! });
        assert.equal(older.messages.length, Math.max(0, n - 50));
        assert.equal(older.hasOlder, false);
      }
    }
  } finally { f.close(); }
});

test("older attachments, pending controls and scheduled followups retain full saved state", async () => {
  const f = fixture();
  const files = new AttachmentService(f.database);
  try {
    f.agents.workspace("task", f.task.id);
    f.database.db.prepare("UPDATE agent_sessions SET thread_id='saved-context-thread',intake_state='ready' WHERE owner_type='task'").run();
    f.seed("task", 12);
    const file = files.initiate("task", f.task.id, "test", { filename: "older.txt", mediaType: "text/plain", size: 7 });
    files.appendChunk(file.id, "test", 0, Buffer.from("context"));
    const uploaded = files.complete(file.id, "test");
    files.attachToMessage([file.id], "task-11");
    f.database.db.prepare("UPDATE chat_messages SET metadata_json=? WHERE id='task-11'").run(JSON.stringify({ attachments: [uploaded] }));
    f.database.db.prepare("UPDATE chat_messages SET role='user' WHERE id='task-10'").run();
    f.database.db.prepare("INSERT INTO pending_messages(message_id) VALUES ('task-10')").run();
    f.agents.saveFollowup(f.task.id, "future-message", { expectedVersion: 0, message: "Retain future followup", localTime: "2099-11-01T12:00", timezone: "Africa/Tunis", policy: "when_available" });
    f.database.db.prepare("UPDATE chat_messages SET created_at='2026-10-30T12:00:00.000Z' WHERE id='future-message'").run();
    f.seed("task", 110, 12);
    const latest = f.agents.workspace("task", f.task.id);
    assert.equal(latest.messages.length, 50);
    assert.equal(latest.messages.some(m => m.pending), false);
    assert.equal(latest.hasPendingMessages, true);
    const page = async (query: MessagePageQuery) => f.agents.messagePage("task", f.task.id, query);
    const middle = await page({ before: latest.history!.oldestCursor! });
    const oldest = await page({ before: middle.oldestCursor! });
    const original = { ...latest, messages: [...oldest.messages, ...middle.messages, ...latest.messages], history: { oldestCursor: oldest.oldestCursor, hasOlder: oldest.hasOlder } };
    assert.equal(original.messages.length, 123);
    assert.equal(original.messages.find(m => m.id === "task-10")?.canCancel, true);
    assert.equal(original.messages.find(m => m.id === "task-11")?.metadata?.attachments?.[0]?.status, "available");
    assert.equal(original.messages.find(m => m.id === "future-message")?.schedule?.state, "pending");
    // Older decoration changes must refresh even when the latest page hash is unchanged.
    f.database.db.prepare("UPDATE attachment_uploads SET status='expired' WHERE id=?").run(file.id);
    f.agents.cancelFollowup(f.task.id, "future-message", 1);
    assert.equal(workspacePoll(f.agents.workspace("task", f.task.id), workspacePoll(latest, {})).workspace, null);
    const refreshed = await reconcileHistory(latest, original.history.oldestCursor, page, () => true);
    assert.equal(refreshed?.messages.find(m => m.id === "task-11")?.metadata?.attachments?.[0]?.status, "expired");
    assert.equal(refreshed?.messages.find(m => m.id === "future-message")?.schedule?.state, "cancelled");
    assert.equal(f.agents.workspace("task", f.task.id).session.threadId, "saved-context-thread");
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()?.n, 245);
  } finally { files.close(); f.close(); }
});
