// Local-only browser fixture: real settings editor, polling, navigation and chat.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "settings-app";
import { api, connection } from "settings-api";
import "settings-styles";

const key = "qahwa-settings-fixture";
const defaults = { name: "Orchestrator", customInstructions: "" };
const stamp = "2026-10-28T10:00:00.000Z";
const read = () => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(defaults));
const history = () => localStorage.getItem("cleaned") ? [] : [{ id: "old", role: "assistant", ownerType: "orchestrator", ownerId: "main", body: "Orchestrator said hello.", metadata: null, createdAt: stamp }];
const workspace = () => ({
  session: { id: "session", ownerType: "orchestrator", ownerId: "main", runState: "idle", surface: "chat", intakeState: "ready", generation: 1 },
  messages: history(), pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
});
const listeners = new Set();
const controls = window.settingsFixture = {
  failSave: false, writes: [], state: "online",
  connect(state) { this.state = state; listeners.forEach(listener => listener(state)); },
};
Object.assign(connection, { state: () => controls.state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  connect: async () => {}, profile: () => ({ serverPublicKey: "settings-server", deviceId: "settings-browser" }) });
Object.assign(api, {
  projects: async () => ({ projects: [] }), tasks: async () => ({ tasks: [] }), devices: async () => ({ devices: [] }),
  orchestratorSettings: async () => ({ settings: read() }),
  saveOrchestratorSettings: async settings => {
    if (controls.failSave) throw new Error("Temporary save failure");
    controls.writes.push(settings); localStorage.setItem(key, JSON.stringify(settings)); return { settings };
  },
  orchestratorPoll: async () => ({ revision: "fixture", messagesRevision: "fixture", workspace: workspace(), capacity: { activeTurns: 0, availableSlots: 1, recommendedParallelism: 1 } }),
  orchestratorUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  cleanOrchestrator: async () => { localStorage.setItem("cleaned", "yes"); return { workspace: workspace() }; },
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
