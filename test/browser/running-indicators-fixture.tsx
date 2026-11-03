import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "indicator-app";
import { api, connection } from "indicator-api";
import "indicator-styles";

const stamp = "2026-10-31T10:00:00.000Z";
const states = ["running", "idle", "waiting", "failed", "interrupted", "not_started"];
const controls = window.runningFixture = { state: "running", taskState: "running", fail: false, polls: 0, workspaceLoads: 0, connected: true,
  connect(value) { this.connected = value; subscribers.forEach(fn => fn(value ? "online" : "offline")); },
};
const subscribers = new Set();
const projects = [{ id: "p", name: "Qahwa tasks", prefix: "QAH", logo: null }];
Object.assign(connection, { state: () => "online", profile: () => null, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); }, connect: async () => {} });
const tasks = () => states.map((state, i) => ({
  id: state, humanId: `QAH-000${i}`, projectId: "p", projectName: "Qahwa tasks", projectPrefix: "QAH", projectLogo: null,
  title: i ? `${state} session with a long title to check truncation` : "Adding running indicators to task conversations",
  status: "in_progress", outcome: null, rank: i, unresolvedCommentCount: 0, version: 1,
  smartMessage: state === "waiting" ? "Waiting for clarification" : state === "idle" ? "Queued work" : "",
  tone: "blue", surface: "chat", sessionState: i ? state : controls.taskState, createdAt: stamp, updatedAt: stamp,
  conversation: { activityAt: stamp, latestMessage: { role: "assistant", preview: "Latest conversation message", createdAt: stamp }, unreadCount: i ? 0 : 120 },
}));
const workspace = () => ({ session: { id: "s", ownerType: "orchestrator", ownerId: "main", runState: controls.state, surface: "chat", intakeState: "ready", generation: 1 },
  messages: [], pendingRequests: [], hasPendingMessages: true, design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [] });
Object.assign(api, {
  projects: async () => ({ projects }), tasks: async () => ({ tasks: tasks() }),
  orchestratorSettings: async () => ({ settings: { name: "Orchestrator", customInstructions: "" } }),
  orchestratorAvatar: async () => ({ avatar: null }), userAvatar: async () => ({ avatar: null }),
  orchestratorUnread: async () => { controls.polls++; if (controls.fail) throw new Error("Temporary poll failure"); return { sessionState: controls.state, readState: { unreadCount: 3, unreadMessageIds: ["unseen"] } }; },
  markOrchestratorRead: async () => { throw new Error("No loaded replies should be marked read"); },
  orchestratorPoll: async () => { controls.workspaceLoads++; return { revision: String(controls.polls), messagesRevision: "initial", workspace: workspace() }; },
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
