import React from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const mode = new URLSearchParams(location.search).get("mode") === "task" ? "task" : "orchestrator";
const key = `pending-fixture-${mode}`;
const timestamp = new Date().toISOString();
let state = JSON.parse(localStorage.getItem(key) || "null") || {
  session: { id: "fixture", ownerType: mode, ownerId: "fixture", runState: "running", surface: "chat", intakeState: "ready", generation: 1 },
  messages: [], pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
const persist = () => localStorage.setItem(key, JSON.stringify(state));
const full = async () => ({ workspace: structuredClone(state), capacity: { activeTurns: 1, availableSlots: 0 } });
const controls = window.pendingFixture = {
  fail: false,
  startNext() { const next = state.messages.find((message) => message.pending); if (next) next.pending = false; persist(); },
  notStarted() { state.session.runState = "not_started"; persist(); },
};
const send = async (...args) => {
  if (controls.fail) throw new Error("Fixture disconnected");
  const text = args[mode === "task" ? 1 : 0];
  const ids = args[mode === "task" ? 2 : 1];
  state.messages.push({ id: crypto.randomUUID(), ownerType: mode, ownerId: "fixture", role: "user", body: text,
    itemId: null, pending: true, createdAt: timestamp,
    metadata: { attachments: ids.map((id) => ({ id, filename: "context.txt", mediaType: "text/plain", size: 7, status: "available", previewUrl: "/unused" })) } });
  persist(); return full();
};
Object.assign(api, {
  task: async () => ({ task: { id: "fixture", humanId: "QAH-0011", title: "Pending messages", projectName: "Qahwa", status: "in_progress" } }),
  workspace: full, orchestrator: full, workspacePoll: full, orchestratorPoll: full,
  sendTaskMessage: send, sendOrchestratorMessage: send, clientDiagnostic: async () => {},
  uploadAttachment: async (_mode, _id, file, progress) => { progress(100); return { id: file.name, filename: file.name, mediaType: file.type, size: file.size, status: "available" }; },
  removeAttachment: async () => {},
});
createRoot(document.getElementById("root")).render(<SessionWorkspace mode={mode} taskId={mode === "task" ? "fixture" : undefined} onError={(message) => { window.fixtureError = message; }} />);
