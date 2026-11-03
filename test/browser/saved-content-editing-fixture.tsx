import React from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api, ApiError } from "chat-api";
import { documentFromPlainText } from "edit-types";
import "chat-styles";

const params = new URLSearchParams(location.search), mode = params.get("mode") || "task";
const key = `saved-edit-${params}`, stamp = new Date().toISOString();
const state = JSON.parse(localStorage.getItem(key) || "null") || {
  task: { id: "fixture", humanId: "EDIT-0001", title: "Original task title", description: documentFromPlainText("Original task description"), version: 1, canEdit: !params.has("active"), projectName: "Qahwa", status: params.has("active") ? "in_progress" : "todo", comments: [], outputs: [] },
  workspace: {
    session: { id: "fixture", ownerType: mode, ownerId: "fixture", runState: params.has("active") ? "running" : "not_started", surface: "chat", intakeState: "ready", generation: 1 },
    messages: [{ id: "saved", ownerType: mode, ownerId: "fixture", role: "user", body: "Original saved text", metadata: { attachments: [{ id: "file", filename: "keep-context.txt", size: 7, mediaType: "text/plain", status: "expired" }], selectedTasks: [{ id: "other", humanId: "EDIT-0002", title: "Selected task" }], selectedExcerpt: { messageId: "source", excerpt: "Keep selected excerpt", role: "assistant" } }, itemId: null, pending: true, canCancel: true, canEdit: true, version: 1, createdAt: stamp }],
    pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
  },
};
const persist = () => localStorage.setItem(key, JSON.stringify(state));
const full = async () => ({ workspace: structuredClone(state.workspace), capacity: { activeTurns: params.has("active") ? 1 : 0, availableSlots: 1 } });
let connected = true;
const root = createRoot(document.getElementById("root"));
const render = () => root.render(<SessionWorkspace mode={mode} taskId={mode === "task" ? "fixture" : undefined} connected={connected} onError={message => { window.fixtureError = message; }} />);
const controls = window.editFixture = {
  calls: [], sends: 0, fail: false, loseResponse: false, delay: false, release: null,
  offline(value) { connected = !value; render(); },
  conflict(kind) { const target = kind === "task" ? state.task : state.workspace.messages[0]; target.version++; if (kind === "task") { target.title = "Newer task title"; target.description = documentFromPlainText("Newer task description"); } else target.body = "Newer saved text"; persist(); },
  start() { state.task.canEdit = false; state.task.status = "in_progress"; state.workspace.messages[0].canEdit = false; state.workspace.messages[0].canCancel = false; persist(); },
  cancel() { state.workspace.messages[0].pending = false; state.workspace.messages[0].canEdit = false; state.workspace.messages[0].canCancel = false; state.workspace.messages[0].cancelledAt = stamp; persist(); },
};
const edit = async (kind, value, expectedVersion) => {
  controls.calls.push({ kind, value, expectedVersion });
  if (controls.delay) await new Promise(resolve => { controls.release = resolve; });
  if (controls.fail) throw new ApiError("Temporary save failure", "request_failed", 503);
  const target = kind === "task" ? state.task : state.workspace.messages[0];
  if (!target.canEdit) throw new ApiError("This item is starting or cancelled", "already_started", 409);
  if (target.version !== expectedVersion) throw new ApiError("Saved content has changed", "version_conflict", 409);
  if (kind === "task") Object.assign(target, { title: value.title, description: value.description });
  else Object.assign(target, { body: value.trim(), editedAt: stamp });
  target.version++; persist();
  if (controls.loseResponse) { controls.loseResponse = false; throw new Error("Connection lost after save"); }
  return kind === "task" ? { task: structuredClone(state.task) } : full();
};
Object.assign(api, {
  task: async () => ({ task: structuredClone(state.task) }), workspace: full, workspacePoll: full, orchestrator: full, orchestratorPoll: full,
  editTask: async (_id, body) => edit("task", body, body.expectedVersion),
  editTaskMessage: async (_id, _messageId, text, version) => edit("message", text, version),
  editOrchestratorMessage: async (_messageId, text, version) => edit("message", text, version),
  sendTaskMessage: async () => { controls.sends++; return full(); }, sendOrchestratorMessage: async () => { controls.sends++; return full(); },
  taskUnread: async () => ({ unreadMessageIds: [], unreadCount: 0 }), markTaskRead: async () => ({ unreadMessageIds: [], unreadCount: 0 }),
  clientDiagnostic: async () => {},
});
render();
