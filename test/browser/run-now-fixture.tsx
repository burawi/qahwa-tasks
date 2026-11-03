import React from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api, ApiError } from "chat-api";
import "chat-styles";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "task" ? "task" : "orchestrator";
const timestamp = new Date().toISOString();
const key = `run-now-${params}`;
const state = JSON.parse(localStorage.getItem(key) || "null") || {
  session: { id: "fixture", ownerType: mode, ownerId: mode === "task" ? "fixture" : "main", runState: "idle", surface: "chat", intakeState: "ready", generation: 1 },
  messages: [
    { id: "started", role: "user", body: "A message that has already started", pending: false },
    { id: "run", role: "user", body: "İ want a coupon to have an expiry dateand a limit of number of uses. Both can be indefinite", pending: true, canRunNow: true, canCancel: true, canEdit: true, metadata: { attachments: [{ id: "file", filename: "context.txt", mediaType: "text/plain", size: 7, status: "available", previewUrl: "/context.txt" }] } },
    { id: "neighbor", role: "user", body: "Keep this other saved message", pending: true, canRunNow: true, canCancel: true, canEdit: true },
  ].map(message => ({ ...message, ownerType: mode, ownerId: "fixture", version: 1, itemId: null, createdAt: timestamp })),
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
const persist = () => localStorage.setItem(key, JSON.stringify(state));
const full = async () => ({ workspace: structuredClone(state), capacity: { activeTurns: state.session.runState === "running" ? 1 : 0, availableSlots: 1, recommendedParallelism: 2 } });
const root = createRoot(document.getElementById("root"));
let connected = true;
const render = () => root.render(<SessionWorkspace mode={mode} taskId={mode === "task" ? "fixture" : undefined} connected={connected} onError={message => { window.fixtureError = message; }} />);
const controls = window.runNowFixture = {
  calls: [], fail: null, hold: false, release: null,
  offline(value) { connected = !value; render(); },
};
const runNow = async (...args) => {
  controls.calls.push(args);
  const id = args[mode === "task" ? 1 : 0];
  const message = state.messages.find(message => message.id === id);
  if (controls.fail === "conflict") {
    message.pending = false; message.canRunNow = false; message.canEdit = false; message.canCancel = false;
    persist(); throw new ApiError("This message is already starting. Refresh the chat.", "message_not_pending", 409);
  }
  if (controls.fail === "capacity") throw new ApiError("Run now is blocked by the safe parallel-work limit. The message is still saved.", "capacity_full", 409);
  if (controls.fail) throw new ApiError("Temporary start failure. The message is still saved.", "message_start_failed", 503);
  if (controls.hold) await new Promise(resolve => { controls.release = resolve; });
  message.pending = false; message.canRunNow = false; message.canEdit = false; message.canCancel = false;
  state.session.runState = "running"; persist(); return full();
};
Object.assign(api, {
  task: async () => ({ task: { id: "fixture", humanId: "RUN-0001", title: "Pending message actions", projectName: "Qahwa", status: "in_progress", comments: [], outputs: [] } }),
  workspace: full, orchestrator: full, workspacePoll: full, orchestratorPoll: full,
  taskUnread: async () => ({ readState: { unreadMessageIds: [], unreadCount: 0 } }), markTaskRead: async () => ({ readState: { unreadMessageIds: [], unreadCount: 0 } }),
  runTaskMessageNow: runNow, runOrchestratorMessageNow: runNow, clientDiagnostic: async () => {},
});
render();
