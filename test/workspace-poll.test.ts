import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, TaskWorkspace } from "../src/domain/types.js";
import { workspacePoll } from "../src/server/workspace-poll.js";
import { mergeWorkspace } from "../src/web/workspace-state.js";

function fixture(): TaskWorkspace {
  return {
    session: { id: "s", ownerType: "task", ownerId: "t", threadId: null, activeTurnId: null, surface: "chat", runState: "idle", generation: 1, intakeState: "ready", lastError: null, createdAt: "now", updatedAt: "now" },
    messages: Array.from({ length: 240 }, (_, i): ChatMessage => ({ id: `m-${i}`, ownerType: "task", ownerId: "t", role: "assistant", itemId: null, body: `### Update ${i}\n\n**History** and a checklist.\n- [x] Keep messages\n\n` .repeat(8), metadata: i % 20 ? null : { attachments: [{ id: `a-${i}`, filename: "notes.txt", size: 123, mediaType: "text/plain", previewUrl: "/preview", status: "available" }] }, createdAt: "now" })),
    pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
  };
}

test("conditional polling preserves stable sections and omits unchanged history during live activity", () => {
  const workspace = fixture();
  const initial = workspacePoll(workspace, {});
  assert.deepEqual(initial.workspace, workspace);
  const idle = workspacePoll(structuredClone(workspace), initial);
  assert.equal(idle.workspace, null);
  const next = structuredClone(workspace);
  next.session.runState = "running";
  next.pendingRequests.push({ id: "approval", ownerId: "t", ownerType: "task", requestType: "command", payload: { command: "npm test" }, status: "pending", createdAt: "now", resolvedAt: null });
  next.workActivities.push({ id: "work", kind: "command", title: "Running tests", detail: null, context: null, status: "running", startedAt: "now", updatedAt: "now" });
  const active = workspacePoll(next, initial);
  assert.ok(active.workspace);
  assert.equal(active.workspace.messages, undefined);
  const merged = mergeWorkspace(workspace, active.workspace);
  assert.equal(merged.messages, workspace.messages);
  assert.equal(merged.session.runState, "running");
  assert.equal(merged.pendingRequests.length, 1);
  assert.equal(merged.workActivities[0]?.title, "Running tests");
  assert.equal(mergeWorkspace(merged, structuredClone(active.workspace)), merged);
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  console.log(JSON.stringify({ fullBytes: bytes({ workspace }), idleBytes: bytes(idle), activeBytes: bytes(active) }));
  assert.ok(bytes(idle) < bytes({ workspace }) / 100);
  assert.ok(bytes(active) < bytes({ workspace }) / 100);
});

test("history reconciliation retains unchanged messages across append, edit, expiration, deletion and reset", () => {
  const previous = fixture();
  const appended = structuredClone(previous);
  appended.messages.push({ ...appended.messages[0]!, id: "new" });
  let merged = mergeWorkspace(previous, appended);
  assert.equal(merged.messages[0], previous.messages[0]);
  assert.equal(merged.messages.length, 241);
  const changed = structuredClone(merged);
  changed.messages[1]!.body = "Edited body";
  changed.messages[0]!.metadata!.attachments![0]!.status = "expired";
  const poll = workspacePoll(changed, workspacePoll(merged, {}));
  assert.ok(poll.workspace?.messages);
  const edited = mergeWorkspace(merged, poll.workspace);
  assert.notEqual(edited.messages[0], merged.messages[0]);
  assert.notEqual(edited.messages[1], merged.messages[1]);
  assert.equal(edited.messages[2], merged.messages[2]);
  const deleted = { ...changed, messages: changed.messages.slice(1) };
  merged = mergeWorkspace(edited, deleted);
  assert.equal(merged.messages.length, 240);
  assert.equal(merged.messages[0], edited.messages[1]);
  const reset = workspacePoll({ ...deleted, messages: [] }, workspacePoll(deleted, {}));
  assert.deepEqual(mergeWorkspace(merged, reset.workspace!).messages, []);
  assert.throws(() => mergeWorkspace(null, { ...deleted, messages: undefined }), /missing history/);
});
