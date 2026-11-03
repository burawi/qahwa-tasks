// Local-only fixture: all data and mutations stay in memory.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "dialog-app";
import { api, connection } from "dialog-api";
import "dialog-styles";

const stamp = "2026-10-31T10:00:00Z";
const project = { id: "project", name: "Dialog project", prefix: "DIA", rootDirectory: "/fixture", taskCount: 0, archivedAt: null, logo: null };
const task = { id: "task", humanId: "DIA-0001", title: "Dialog task", projectId: "project", projectName: "Dialog project", status: "todo", comments: [], outputs: [], description: { type: "doc", content: [] }, version: 1 };
const workspace = {
  session: { id: "session", ownerType: "task", ownerId: "task", runState: "not_started", surface: "chat", intakeState: "ready", generation: 1 },
  messages: [{ id: "message", ownerType: "task", ownerId: "task", role: "user", body: "Keep this history and attachment", metadata: null, createdAt: stamp, pending: true }],
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
const settings = { name: "Bean", customInstructions: "Keep these instructions" };
let projects = [project], devices = [{ id: "device", name: "Fixture phone", lastSeenAt: stamp, revokedAt: null }];
const listeners = new Set();
const controls = window.dialogFixture = {
  state: "online", calls: [], fail: false, hold: false, release: null, refreshFail: false,
  connect(state) { this.state = state; listeners.forEach(listener => listener(state)); },
  start() { task.status = "in_progress"; workspace.session.runState = "idle"; },
  running() { workspace.session.runState = "running"; },
  async operation(name, args = []) {
    this.calls.push({ name, args });
    if (this.fail) throw new Error("Temporary action failure. Please retry.");
    if (this.hold) await new Promise(resolve => { this.release = resolve; });
  },
};
Object.assign(connection, { state: () => controls.state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  connect: async () => {}, profile: () => ({ serverPublicKey: "dialog-server", deviceId: "dialog-browser" }),
  disconnect: () => { controls.calls.push({ name: "disconnect" }); controls.connect("unpaired"); },
});
const poll = async () => {
  if (controls.refreshFail) throw new Error("Refresh unavailable");
  return { workspace: structuredClone(workspace), capacity: { activeTurns: 0, availableSlots: 1, recommendedParallelism: 1 } };
};
Object.assign(api, {
  projects: async () => {
    if (controls.refreshFail) throw new Error("Refresh unavailable");
    return { projects: structuredClone(projects) };
  },
  tasks: async () => ({ tasks: [] }), devices: async () => ({ devices: structuredClone(devices) }),
  userAvatar: async () => ({ avatar: null }), orchestratorAvatar: async () => ({ avatar: null }),
  orchestratorSettings: async () => ({ settings }),
  task: async () => ({ task: structuredClone(task) }), workspacePoll: poll, workspace: poll, orchestratorPoll: poll,
  taskUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  orchestratorUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  markTaskRead: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  transition: async (...args) => {
    await controls.operation("cancel", args);
    if (args[3] && task.status !== "todo") throw new Error("This task has already started. Refresh before cancelling it.");
    task.status = "closed"; workspace.messages[0].pending = false; return { task };
  },
  cleanOrchestrator: async () => { await controls.operation("clean"); workspace.messages = []; return { workspace }; },
  deleteProject: async id => { await controls.operation("delete", [id]); projects = []; },
  revokeDevice: async id => { await controls.operation("revoke", [id]); devices = []; },
  exportData: async () => { await controls.operation("export"); return { fixture: "encrypted content" }; },
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
