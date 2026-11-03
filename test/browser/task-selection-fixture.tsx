// Local-only fixture for the real list, navigation, composer and saved context UI.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "selection-app";
import { api, connection } from "selection-api";
import "selection-styles";

const stamp = "2026-10-28T10:00:00.000Z";
const projects = [{ id: "one", name: "Qahwa Tasks", prefix: "QAH", logo: null }, { id: "two", name: "Other project", prefix: "OTH", logo: null }];
const tasks = Array.from({ length: 24 }, (_, index) => {
  const project = projects[index % 2];
  return { id: `task-${index}`, humanId: `${project.prefix}-${String(index + 1).padStart(4, "0")}`, title: `Task ${index + 1}: preserve this selected conversation and its original title`,
    projectId: project.id, projectName: project.name, projectPrefix: project.prefix, projectLogo: null,
    status: index === 23 ? "closed" : "todo", outcome: index === 23 ? "completed" : null, rank: index, version: 1, unresolvedCommentCount: 0,
    smartMessage: "Waiting for review", tone: "blue", surface: "chat", sessionState: "idle", createdAt: stamp, updatedAt: stamp,
    conversation: { activityAt: stamp, unreadCount: index === 0 ? 3 : 0, latestMessage: { role: "assistant", preview: "A conversation preview remains available", createdAt: stamp } } };
});
const historyKey = "qahwa-selection-fixture-history";
const messages = () => JSON.parse(localStorage.getItem(historyKey) ?? "[]");
const workspace = (mode = "orchestrator", ownerId = "main") => ({
  session: { id: "session", ownerType: mode, ownerId, runState: "idle", surface: "chat", intakeState: "ready", generation: 1 },
  messages: mode === "orchestrator" ? messages() : [{ id: "reply", role: "assistant", ownerType: mode, ownerId, body: "Task conversation", metadata: null, createdAt: stamp }],
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
});
const controls = window.selectionFixture = { sends: [], reads: [], holdSend: false, releaseSend: null, failSend: false, tasks };
Object.assign(connection, { state: () => "online", subscribe: () => () => {}, connect: async () => {}, profile: () => ({ serverPublicKey: "fixture-server", deviceId: "fixture-browser" }) });
Object.assign(api, {
  projects: async () => ({ projects }),
  tasks: async (scope, projectId) => ({ tasks: tasks.filter(t => (scope === "closed" ? t.status === "closed" : t.status !== "closed") && (!projectId || projectId === t.projectId)) }),
  task: async (id) => ({ task: { ...tasks.find(t => t.id === id || t.humanId === id), description: { type: "doc" }, outputs: [], comments: [], relatedTasks: [] } }),
  workspacePoll: async (id) => ({ revision: "fixture", messagesRevision: "fixture", workspace: workspace("task", id) }),
  orchestratorPoll: async () => ({ revision: "fixture", messagesRevision: "fixture", workspace: workspace(), capacity: { activeTurns: 0, availableSlots: 1, recommendedParallelism: 1 } }),
  orchestratorUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  taskUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  markTaskRead: async (id, ids) => { controls.reads.push({ id, ids }); return { readState: { unreadCount: 0, unreadMessageIds: [] } }; },
  sendOrchestratorMessage: async (message, attachmentIds, selectedTaskIds) => {
    const selectedTasks = selectedTaskIds.map(id => { const { humanId, title } = tasks.find(t => t.id === id); return { id, humanId, title }; });
    const value = { message, attachmentIds, selectedTaskIds: [...selectedTaskIds], selectedTasks };
    controls.sends.push(value);
    if (controls.holdSend) await new Promise(resolve => { controls.releaseSend = resolve; });
    if (controls.failSend) throw new Error("Temporary send failure");
    localStorage.setItem(historyKey, JSON.stringify([...messages(), { id: crypto.randomUUID(), ownerType: "orchestrator", ownerId: "main", role: "user", body: message, metadata: { selectedTasks }, pending: true, createdAt: stamp }]));
    return { workspace: workspace() };
  },
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
