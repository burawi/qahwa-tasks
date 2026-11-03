// Local-only fixture: real App, unread hook, navigation, and message components.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "unread-app";
import { api, connection } from "unread-api";
import "unread-styles";

const stamp = "2026-10-28T10:00:00.000Z";
const key = "qahwa-unread-fixture";
const initial = { messages: [
  { id: "read", role: "assistant", body: "Previously read reply" },
  { id: "first", role: "assistant", body: "First unread reply" },
  { id: "second", role: "assistant", body: "Second unread reply" },
  { id: "user", role: "user", body: "User request" },
  { id: "system", role: "system", body: "System observation" },
].map((message) => ({ ...message, ownerType: "orchestrator", ownerId: "main", itemId: message.id, metadata: null, createdAt: stamp })), readIds: ["read"] };
if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(initial));
const state = () => JSON.parse(localStorage.getItem(key));
const persist = (value) => localStorage.setItem(key, JSON.stringify(value));
const readState = () => {
  const value = state();
  const ids = value.messages.filter((message) => message.role === "assistant" && !value.readIds.includes(message.id)).map((message) => message.id);
  return { unreadMessageIds: ids, unreadCount: ids.length };
};
const controls = window.unreadFixture = {
  writes: [], failRead: false, holdHistory: false, releaseHistory: null, hidden: false, blurred: false,
  add(id) { const value = state(); value.messages.push({ ...initial.messages[1], id, itemId: id, body: `Unread reply ${id}` }); persist(value); },
  visibility(hidden, blurred = hidden) {
    this.hidden = hidden; this.blurred = blurred;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(blurred ? "blur" : "focus"));
  },
};
const realFocus = document.hasFocus.bind(document);
const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get;
Object.defineProperty(document, "visibilityState", { get: () => controls.hidden ? "hidden" : visibility.call(document) });
document.hasFocus = () => !controls.blurred && realFocus();
const full = async () => {
  if (controls.holdHistory) await new Promise((resolve) => { controls.releaseHistory = resolve; });
  return { workspace: {
    session: { id: "fixture", ownerType: "orchestrator", ownerId: "main", runState: "idle", surface: "chat", intakeState: "ready", generation: 1 },
    messages: state().messages, pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
  }, revision: "fixture", messagesRevision: "fixture", capacity: { activeTurns: 0, recommendedParallelism: 2, availableSlots: 2 } };
};
Object.assign(connection, { state: () => "online", subscribe: () => () => {}, connect: async () => {} });
Object.assign(api, {
  projects: async () => ({ projects: [] }), tasks: async () => ({ tasks: [] }),
  orchestratorPoll: full,
  orchestratorUnread: async () => ({ readState: readState() }),
  markOrchestratorRead: async (ids) => {
    controls.writes.push({ ids, hidden: document.visibilityState !== "visible", focused: document.hasFocus() });
    if (controls.failRead) throw new Error("Temporary acknowledgement failure");
    const value = state(); value.readIds = [...new Set([...value.readIds, ...ids])]; persist(value);
    return { readState: readState() };
  },
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
