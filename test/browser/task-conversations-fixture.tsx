// Local fixture for the real task list, workspace, navigation and shared read hook.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "conversation-app";
import { api, connection } from "conversation-api";
import "conversation-styles";

const stamp = "2026-10-28T10:00:00.000Z";
const projects = [{ id: "project", name: "Qahwa tasks and conversations", prefix: "QAH", logo: null }, { id: "other", name: "Other project", prefix: "OTH", logo: null }];
const tasks = [
  { id: "older", humanId: "QAH-0001", title: "A long task title that still leaves room for unread counts and the latest activity time", unread: 1, project: projects[0], status: "in_progress", tone: "orange" },
  { id: "latest", humanId: "OTH-0001", title: "The most recent conversation", unread: 120, project: projects[1], status: "in_review", tone: "green" },
  { id: "empty", humanId: "QAH-0002", title: "No conversation yet", unread: 0, project: projects[0], status: "backlog", tone: "neutral" },
  { id: "closed", humanId: "QAH-0003", title: "Completed conversation", unread: 0, project: projects[0], status: "closed", tone: "green" },
].map((task, rank) => ({ ...task, projectId: task.project.id, projectName: task.project.name, projectPrefix: task.project.prefix, projectLogo: null,
  outcome: task.status === "closed" ? "completed" : null, rank, version: 1, unresolvedCommentCount: 0,
  smartMessage: task.id === "older" ? "Action needed: approve deployment before continuing" : task.id === "empty" ? "Not started" : "Waiting for your review",
  surface: "chat", sessionState: "idle", createdAt: stamp, updatedAt: stamp }));
const key = "qahwa-task-conversation-fixture";
const message = (id, ownerId, body, role = "assistant") => ({ id, ownerType: "task", ownerId, body, role, itemId: id, metadata: null, createdAt: stamp });
const initial = { readIds: [], messages: tasks.flatMap(task => Array.from({ length: task.unread }, (_, i) => message(`${task.id}-${i}`, task.id, `${task.title} reply ${i}`))) };
if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(initial));
const state = () => JSON.parse(localStorage.getItem(key));
const save = (value) => localStorage.setItem(key, JSON.stringify(value));
const taskFor = (id) => tasks.find(task => task.id === id || task.humanId === id);
const readState = (id) => {
  const value = state(), task = taskFor(id);
  const ids = value.messages.filter(m => m.ownerId === task.id && m.role === "assistant" && !value.readIds.includes(m.id)).map(m => m.id);
  return { unreadMessageIds: ids, unreadCount: ids.length };
};
const controls = window.conversationFixture = {
  writes: [], holdHistory: false, releaseHistory: null, hidden: false, blurred: false, failRead: false,
  add(id, ownerId) { const value = state(); value.messages.push(message(id, ownerId, `New reply ${id}`)); save(value); },
  visibility(hidden, blurred = hidden) { this.hidden = hidden; this.blurred = blurred; document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event(blurred ? "blur" : "focus")); },
};
const realFocus = document.hasFocus.bind(document);
const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get;
Object.defineProperty(document, "visibilityState", { get: () => controls.hidden ? "hidden" : visibility.call(document) });
document.hasFocus = () => !controls.blurred && realFocus();
Object.assign(connection, { state: () => "online", subscribe: () => () => {}, connect: async () => {} });
Object.assign(api, {
  projects: async () => ({ projects }),
  tasks: async (scope, projectId) => ({ tasks: tasks.filter(t => (scope === "closed" ? t.status === "closed" : t.status !== "closed") && (!projectId || t.projectId === projectId))
    .sort((a, b) => Number(b.id === "latest") - Number(a.id === "latest")).map(task => ({ ...task, conversation: { activityAt: stamp, unreadCount: readState(task.id).unreadCount,
      latestMessage: task.unread ? { role: "assistant", preview: "The latest visible reply, with enough detail to preview the conversation.", createdAt: stamp } : null } })) }),
  task: async (id) => ({ task: { ...taskFor(id), outputs: [], comments: [], relatedTasks: [], description: { type: "doc" } } }),
  workspacePoll: async (id) => {
    if (controls.holdHistory) await new Promise(resolve => { controls.releaseHistory = resolve; });
    const task = taskFor(id);
    return { revision: "fixture", messagesRevision: "fixture", workspace: { session: { id: `session-${task.id}`, ownerType: "task", ownerId: task.id, runState: "idle", surface: "chat", intakeState: "ready", generation: 1 },
      messages: state().messages.filter(m => m.ownerId === task.id), pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [] } };
  },
  taskUnread: async (id) => ({ readState: readState(id) }),
  markTaskRead: async (id, ids) => {
    controls.writes.push({ owner: taskFor(id).id, ids, hidden: document.visibilityState !== "visible", focused: document.hasFocus() });
    if (controls.failRead) throw new Error("Temporary read failure");
    const value = state(); value.readIds = [...new Set([...value.readIds, ...ids])]; save(value);
    return { readState: readState(id) };
  },
  orchestratorUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
