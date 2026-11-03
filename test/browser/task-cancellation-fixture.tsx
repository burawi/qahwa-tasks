import React from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const params = new URLSearchParams(location.search);
const key = `cancellation-${params}`;
const timestamp = new Date().toISOString();
const state = JSON.parse(localStorage.getItem(key) || "null") || {
  task: { id: "fixture", humanId: "CAN-0001", title: "Cancel queued work", projectName: "Qahwa", status: params.get("status") || "backlog", outcome: null, comments: [], outputs: [] },
  workspace: {
    session: { id: "fixture", ownerType: "task", ownerId: "fixture", runState: params.get("run") || "not_started", surface: "chat", intakeState: "pending", generation: 1 },
    messages: [{ id: "saved", ownerType: "task", ownerId: "fixture", role: "user", body: "Keep these instructions", metadata: null, itemId: null, pending: true, createdAt: timestamp }],
    pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
  },
};
const persist = () => localStorage.setItem(key, JSON.stringify(state));
const full = async () => ({ workspace: structuredClone(state.workspace), capacity: { activeTurns: 0, availableSlots: 1 } });
let connected = true;
const root = createRoot(document.getElementById("root"));
const render = () => root.render(<SessionWorkspace mode="task" taskId="fixture" connected={connected} onError={message => { window.fixtureError = message; }} />);
const controls = window.cancellationFixture = { calls: [], fail: false, release: null, offline() { connected = false; render(); } };
Object.assign(api, {
  task: async () => ({ task: structuredClone(state.task) }), workspace: full, workspacePoll: full,
  taskUnread: async () => ({ unreadMessageIds: [], unreadCount: 0 }), markTaskRead: async () => ({ unreadMessageIds: [], unreadCount: 0 }),
  transition: async (...args) => {
    controls.calls.push(args);
    if (controls.fail) throw new Error("This task has already started. Refresh before cancelling it.");
    await new Promise(resolve => { controls.release = resolve; });
    state.task.status = "closed"; state.task.outcome = "cancelled";
    state.workspace.messages[0].pending = false;
    persist(); return { task: structuredClone(state.task) };
  },
  clientDiagnostic: async () => {},
});
render();
