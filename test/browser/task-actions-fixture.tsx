// Local-only fixture. All transitions, notifications and interruptions stay in memory.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "actions-source";
import { api } from "actions-api";
import "actions-styles";

const params = new URLSearchParams(location.search);
const task = {
  id: "fixture", humanId: "QAH-0070", title: "Task actions with a long task title",
  projectName: "Qahwa", status: params.get("status") || "in_review", canEdit: params.get("status") === "todo",
  idleNotificationsEnabled: false, comments: [], outputs: [], description: { type: "doc", content: [] }, version: 1,
};
const document = { format: "web", artboard: { name: "Controls", width: 600, height: 500, background: "#eee7ff" },
  html: '<main data-qahwa-id="main">Canvas remains available</main>', css: 'main{padding:40px;font:24px sans-serif}' };
const design = { id: "page", name: "Controls", revision: 1, document };
const canvas = params.has("canvas");
const workspace = {
  session: { id: "session", ownerType: "task", ownerId: task.id, runState: params.get("run") || "idle", accessMode: "worktree-write", activeAccessMode: "worktree-write", accessVersion: 1, surface: canvas ? "design" : "chat", intakeState: "ready", generation: 1 },
  messages: [{ id: "message", ownerType: "task", ownerId: task.id, role: "user", body: "Keep this history", createdAt: "2026-10-31T10:00:00Z", metadata: null }],
  pendingRequests: [], design: canvas ? design : null, designPages: canvas ? [design] : [], selectedDesignPageId: canvas ? "page" : null, recentEvents: [], workActivities: [],
};
let setConnected;
const fixture = window.actionsFixture = {
  calls: [], fail: false, hold: false, release: null, refreshFail: false,
  setStatus(status) { task.status = status; task.canEdit = status === "todo"; },
  setRunState(state) { workspace.session.runState = state; },
  connect(value) { setConnected(value); },
  async operation(name, args = []) {
    this.calls.push({ name, args });
    if (this.fail) throw new Error("Temporary action failure. Please retry.");
    if (this.hold) await new Promise(resolve => { this.release = resolve; });
  },
};
const poll = async () => {
  if (fixture.refreshFail) throw new Error("Refresh unavailable");
  return { workspace: structuredClone(workspace), capacity: { activeTurns: 0, availableSlots: 1, recommendedParallelism: 1 } };
};
const unread = async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } });
Object.assign(api, {
  task: async () => ({ task: structuredClone(task) }), workspacePoll: poll, orchestratorPoll: poll,
  taskUnread: unread, markTaskRead: unread, orchestratorUnread: unread, markOrchestratorRead: unread,
  userAvatar: async () => ({ avatar: null }), orchestratorAvatar: async () => ({ avatar: null }),
  transition: async (...args) => {
    await fixture.operation("transition", args);
    if (args[3] && !["backlog", "todo"].includes(task.status)) throw new Error("This task has already started. Refresh before cancelling it.");
    if (["running", "waiting"].includes(workspace.session.runState)) throw new Error("Pause this task first");
    task.status = "closed"; return { task: structuredClone(task) };
  },
  interruptTask: async id => { await fixture.operation("interruptTask", [id]); workspace.session.runState = "idle"; },
  interruptOrchestrator: async () => { await fixture.operation("interruptOrchestrator"); workspace.session.runState = "idle"; },
  cleanOrchestrator: async () => { await fixture.operation("clean"); workspace.messages = []; },
  setIdleNotifications: async (_id, enabled) => {
    await fixture.operation("notifications", [enabled]); task.idleNotificationsEnabled = enabled; return { task: structuredClone(task) };
  },
  appPushSettings: async () => ({ publicKey: "AQID", subscribed: true }), saveAppPushSubscription: async () => {},
  codexUsage: async () => ({ usage: null }), clientDiagnostic: async () => {},
});
function Fixture() {
  const [connected, updateConnected] = useState(true);
  setConnected = updateConnected;
  return <SessionWorkspace mode={params.has("orchestrator") ? "orchestrator" : "task"} taskId={params.has("orchestrator") ? undefined : task.id}
    connected={connected} onError={message => { window.fixtureError = message; }} />;
}
createRoot(window.document.getElementById("root")).render(<StrictMode><Fixture /></StrictMode>);
