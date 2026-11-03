import React from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "task" ? "task" : "orchestrator";
const timestamp = new Date().toISOString();
const key = `message-cancellation-${params}`;
const state = JSON.parse(localStorage.getItem(key) || "null") || {
  session: { id: "fixture", ownerType: mode, ownerId: mode === "task" ? "fixture" : "main", runState: params.get("run") || "running", surface: "chat", intakeState: "ready", generation: 1 },
  messages: [
    { id: "starting", role: "user", body: "Message already starting", pending: true, canCancel: false },
    { id: "cancel", role: "user", body: "Cancel these saved instructions", pending: true, canCancel: true, metadata: { attachments: [{ id: "file", filename: "context.txt", mediaType: "text/plain", size: 7, status: "available", previewUrl: "/context.txt" }] } },
    { id: "neighbor", role: "user", body: "Keep this neighboring message", pending: true, canCancel: true },
  ].map(message => ({ ...message, ownerType: mode, ownerId: "fixture", itemId: null, createdAt: timestamp })),
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
const persist = () => localStorage.setItem(key, JSON.stringify(state));
const full = async () => ({ workspace: structuredClone(state), capacity: { activeTurns: 1, availableSlots: 0 } });
const root = createRoot(document.getElementById("root"));
let connected = true;
const render = () => root.render(<SessionWorkspace mode={mode} taskId={mode === "task" ? "fixture" : undefined} connected={connected} onError={message => { window.fixtureError = message; }} />);
const controls = window.messageCancellationFixture = {
  calls: [], fail: null, hold: false, release: null,
  offline(value) { connected = !value; render(); },
};
const cancel = async (...args) => {
  controls.calls.push(args);
  const id = args[mode === "task" ? 1 : 0];
  if (controls.fail) {
    if (controls.fail === "conflict") {
      state.messages.find(message => message.id === id).canCancel = false;
      persist(); throw new Error("This message is already starting. Refresh the chat.");
    }
    throw new Error("Disconnected. Reconnect and retry cancellation.");
  }
  if (controls.hold) await new Promise(resolve => { controls.release = resolve; });
  const message = state.messages.find(message => message.id === id);
  message.pending = false; message.canCancel = false; message.cancelledAt = new Date().toISOString();
  persist(); return full();
};
Object.assign(api, {
  task: async () => ({ task: { id: "fixture", humanId: "MSG-0001", title: "Cancel a pending message", projectName: "Qahwa", status: "in_progress", comments: [], outputs: [] } }),
  workspace: full, orchestrator: full, workspacePoll: full, orchestratorPoll: full,
  taskUnread: async () => ({ readState: { unreadMessageIds: [], unreadCount: 0 } }), markTaskRead: async () => ({ readState: { unreadMessageIds: [], unreadCount: 0 } }),
  cancelTaskMessage: cancel, cancelOrchestratorMessage: cancel, clientDiagnostic: async () => {},
});
render();
