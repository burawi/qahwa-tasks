import React from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const params = new URLSearchParams(location.search);
const key = `restore-${params}`;
const timestamp = new Date().toISOString();
const initial = {
  task: { id: "fixture", humanId: "RST-0001", version: 3, title: "Restore saved work", projectName: "Qahwa", status: "closed", outcome: params.get("outcome") || "completed", comments: [], outputs: [] },
  workspace: {
    session: { id: "fixture", ownerType: "task", ownerId: "fixture", threadId: "saved-thread", runState: "idle", surface: "chat", intakeState: "ready", generation: 1 },
    messages: [{ id: "saved", ownerType: "task", ownerId: "fixture", role: "user", body: "Keep these instructions and saved history", metadata: null, itemId: null, pending: false, createdAt: timestamp }],
    pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
  },
};
const read = () => JSON.parse(localStorage.getItem(key) || "null") || structuredClone(initial);
const saveRestore = () => {
  const state = read(); state.task.status = "backlog"; state.task.outcome = null; state.task.version++;
  state.workspace.session.generation++; localStorage.setItem(key, JSON.stringify(state));
  return { task: state.task };
};
const full = async () => ({ workspace: read().workspace, capacity: { activeTurns: 0, availableSlots: 1 } });
let connected = true;
const root = createRoot(document.getElementById("root"));
const render = () => root.render(<SessionWorkspace mode="task" taskId="fixture" connected={connected} onError={message => { window.fixtureError = message; }} />);
const controls = window.restoreFixture = { calls: [], fail: false, lostAck: false, release: null,
  offline() { connected = false; render(); }, externalRestore: saveRestore };
Object.assign(api, {
  task: async () => ({ task: read().task }), workspace: full, workspacePoll: full,
  taskUnread: async () => ({ unreadMessageIds: [], unreadCount: 0 }), markTaskRead: async () => ({ unreadMessageIds: [], unreadCount: 0 }),
  restoreTask: async (...args) => {
    controls.calls.push(args);
    if (controls.fail) throw new Error("This session changed. Refresh before restoring it.");
    await new Promise(resolve => { controls.release = resolve; });
    const result = saveRestore();
    if (controls.lostAck) throw new Error("Connection interrupted");
    return result;
  },
  triggerTask: async () => { throw new Error("Restore must not start work"); },
  sendTaskMessage: async () => { throw new Error("Restore must not send messages"); },
  clientDiagnostic: async () => {},
});
render();
