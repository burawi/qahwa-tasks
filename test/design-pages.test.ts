import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { documentFromPlainText, type DesignDocument } from "../src/domain/types.js";
import { AppDatabase } from "../src/server/database.js";
import { migrateDesignPages, designPages, selectedDesignPageId } from "../src/server/design-pages.js";
import { coordinationFixture, until } from "./helpers/orchestrator-replies.js";

const document = (text: string): DesignDocument => ({ format: "web", artboard: { width: 390, height: 844, name: text, background: "#fff" }, html: `<button data-qahwa-id="shared">${text}</button>`, css: "button{color:purple}" });

test("migration preserves current, every snapshot, anchors and legacy records across reopening", () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    const orphan = f.task("Snapshots only", task.projectId);
    const timestamp = "2026-10-01T00:00:00.000Z";
    f.database.db.prepare("INSERT INTO design_documents VALUES (?, ?, 4, ?)").run(task.id, JSON.stringify(document("Current")), timestamp);
    for (const [id, taskId, name] of [["snapshot-one", task.id, "Named page"], ["snapshot-duplicate", task.id, "Named page"], ["orphan", orphan.id, "Older page"]]) {
      f.database.db.prepare("INSERT INTO design_versions VALUES (?, ?, ?, ?, 2, ?)").run(id, taskId, name, JSON.stringify(document(name!)), timestamp);
    }
    const anchors = ["current", "snapshot-one", "snapshot-duplicate"].map(versionId => f.tasks.addComment(task.id, {
      body: documentFromPlainText(`Feedback ${versionId}`),
      metadata: { extra: "preserve", canvas: { versionId, elementId: "shared", label: "shared", revision: 2 } },
    }, "user"));
    f.tasks.resolveComment(anchors[1]!.id, true, "codex", documentFromPlainText("Addressed on this page"));
    f.agents.workspace("task", task.id);
    f.database.db.prepare("UPDATE agent_sessions SET active_turn_id = 'legacy-turn', run_state = 'running' WHERE owner_id = ?").run(task.id);
    f.database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES ('legacy-pending', 'task', ?, 'user', 'Legacy pending request', ?)").run(task.id, timestamp);
    f.database.db.prepare("INSERT INTO pending_messages (message_id) VALUES ('legacy-pending')").run();
    f.database.deleteSetting("design_pages_migrated");
    migrateDesignPages(f.database.db);
    const pages = designPages(f.database.db, task.id);
    assert.equal(pages.length, 3, "Duplicate names/content must not collapse snapshots");
    assert.deepEqual(pages[0]!.document, document("Current"));
    assert.equal(pages[0]!.revision, 4);
    assert.equal(pages[0]!.updatedAt, timestamp);
    assert.equal(selectedDesignPageId(f.database.db, task.id), `canvas:${task.id}`);
    assert.equal(selectedDesignPageId(f.database.db, orphan.id), "orphan");
    assert.equal((f.database.db.prepare("SELECT page_id FROM design_page_turns WHERE turn_id = 'legacy-turn'").get() as any).page_id, `canvas:${task.id}`);
    assert.equal(JSON.parse((f.database.db.prepare("SELECT metadata_json FROM chat_messages WHERE id = 'legacy-pending'").get() as any).metadata_json).designPageId, `canvas:${task.id}`);
    const migrated = f.tasks.getTask(task.id).comments;
    assert.ok(migrated.find(comment => comment.id === anchors[1]!.id)!.resolvedAt);
    assert.equal(migrated.find(comment => comment.id === anchors[1]!.id)!.replies[0]!.plainText, "Addressed on this page");
    for (const anchor of anchors) {
      const found = migrated.find(comment => comment.id === anchor.id)!;
      assert.equal(found.metadata!.extra, "preserve");
      const previous = anchor.metadata!.canvas as { versionId: string };
      assert.deepEqual(found.metadata!.canvas, { ...previous, pageId: previous.versionId === "current" ? `canvas:${task.id}` : previous.versionId });
    }
    f.agents.renameDesignPage(task.id, "snapshot-one", "Renamed after migration");
    f.agents.selectDesignPage(task.id, "snapshot-one");
    const reopened = new AppDatabase({ dataDir: f.root } as any);
    try {
      assert.equal(designPages(reopened.db, task.id).length, 3);
      assert.equal(selectedDesignPageId(reopened.db, task.id), "snapshot-one");
      assert.equal(designPages(reopened.db, task.id)[1]!.name, "Renamed after migration");
      assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM design_versions").get() as any).n, 3);
      assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM design_documents").get() as any).n, 1);
      assert.deepEqual(reopened.db.pragma("foreign_key_check"), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("running and queued turns retain their request pages, comments and response targets", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    f.agents.workspace("task", task.id);
    f.database.db.prepare("UPDATE agent_sessions SET intake_state = 'ready' WHERE owner_id = ?").run(task.id);
    const first = f.agents.createDesignPage(task.id, "Home").selectedDesignPageId!;
    const second = f.agents.createDesignPage(task.id, "Details").selectedDesignPageId!;
    const comment = (pageId: string, text: string) => f.tasks.addComment(task.id, { body: documentFromPlainText(text), metadata: { canvas: { pageId, elementId: "shared", label: "shared", revision: 1 } } }, "user");
    comment(first, "Home feedback"); comment(second, "Details feedback");
    f.agents.selectDesignPage(task.id, first);
    await f.agents.send("task", task.id, "Change Home");
    const workspace = () => f.agents.workspace("task", task.id);
    const { threadId, activeTurnId: turnId } = workspace().session;
    f.agents.selectDesignPage(task.id, second);
    await f.agents.send("task", task.id, "Change Details");
    f.database.db.prepare("UPDATE pending_messages SET dispatch_order = 1").run();
    f.agents.selectDesignPage(task.id, first);
    const prompts = () => f.requests().filter(r => r.method === "turn/start").map(r => r.params.input[0].text as string);
    assert.match(prompts()[0]!, /Home feedback/);
    assert.ok(!prompts()[0]!.includes("Details feedback"));
    const response = (id: string, turn: string, text: string) => ({ method: "item/completed", params: { threadId, turnId: turn, item: { id, type: "agentMessage", phase: "final_answer", text: `Updated ${text}<qahwa-design>${JSON.stringify(document(text))}</qahwa-design>` } } });
    const emit = async (events: unknown[], condition: () => boolean) => { writeFileSync(join(f.root, "events.json"), JSON.stringify(events)); await until(condition, "Expected canvas event"); };
    // Select Details during Home's response. Only Home may change.
    f.agents.selectDesignPage(task.id, second);
    await emit([response("first-reply", turnId!, "Home update")], () => workspace().designPages[0]!.revision === 2);
    assert.equal(workspace().selectedDesignPageId, second);
    assert.equal(workspace().design!.document.html, "");
    assert.match(workspace().designPages[0]!.document.html, /Home update/);
    assert.equal(workspace().messages.find(m => m.role === "assistant")!.metadata!.designPageId, first);
    assert.equal(workspace().messages.find(m => m.body === "Change Details")!.metadata!.designPageId, second);
    // Replay must not create a revision or a page.
    await emit([response("first-reply", turnId!, "Home update")], () => (f.database.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE item_id IS NULL AND event_type = 'item/completed'").get() as any).n >= 2);
    assert.equal(workspace().designPages[0]!.revision, 2);
    f.agents.selectDesignPage(task.id, first);
    await emit([{ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }], () => prompts().length === 2);
    assert.match(prompts()[1]!, /Details feedback/);
    assert.ok(!prompts()[1]!.includes("Home feedback"));
    await until(() => Boolean(workspace().session.activeTurnId && workspace().session.activeTurnId !== turnId), "Queued turn did not start");
    const nextTurn = workspace().session.activeTurnId!;
    await emit([response("second-reply", nextTurn, "Details update")], () => workspace().designPages[1]!.revision === 2);
    assert.equal(workspace().selectedDesignPageId, first);
    assert.match(workspace().design!.document.html, /Home update/);
    assert.match(workspace().designPages[1]!.document.html, /Details update/);
    assert.equal(workspace().designPages.length, 2);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM design_versions").get() as any).n, 0, "Updates never generate snapshots");
    const other = f.task("Other task", task.projectId);
    await assert.rejects(f.agents.send("task", other.id, "Wrong page", false, "user", [], undefined, [], first), /Canvas page not found/);
  } finally { f.close(); }
});

test("a first returned design creates one persistent page even if the user creates another while running", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    f.agents.workspace("task", task.id);
    f.database.db.prepare("UPDATE agent_sessions SET intake_state = 'ready' WHERE owner_id = ?").run(task.id);
    await f.agents.send("task", task.id, "Make a canvas");
    const { threadId, activeTurnId: turnId } = f.agents.workspace("task", task.id).session;
    const selected = f.agents.createDesignPage(task.id, "Other page").selectedDesignPageId;
    writeFileSync(join(f.root, "events.json"), JSON.stringify([1, 2].map(n => ({ method: "item/completed", params: { threadId, item: { id: `initial-${n}`, type: "agentMessage", text: `<qahwa-design>${JSON.stringify(document(`First design ${n}`))}</qahwa-design>` } } }))));
    await until(() => f.agents.workspace("task", task.id).messages.filter(m => m.role === "assistant").length === 2, "First designs did not arrive");
    const workspace = f.agents.workspace("task", task.id);
    assert.equal(workspace.selectedDesignPageId, selected);
    assert.equal(workspace.designPages.length, 2);
    assert.equal(workspace.designPages[1]!.revision, 2);
    assert.match(workspace.designPages[1]!.document.html, /First design 2/);
  } finally { f.close(); }
});
