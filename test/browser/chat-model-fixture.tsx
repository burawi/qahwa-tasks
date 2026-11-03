import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "model-source";
import { api } from "model-api";
import "model-styles";
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "orchestrator" ? "orchestrator" : "task";
const canvas = params.get("mode") === "canvas";
const document = { format: "web", artboard: { width: 390, height: 500, background: "#fff", name: "Preserved canvas" }, html: '<main data-qahwa-id="preserved">Preserved canvas content</main>', css: "main{padding:24px;color:#533193}" };
const receipt = status => ({ messageId: `guidance-${status}`, taskId: "fixture", taskTitle: "Preserved task", status, detail: `Internal receipt detail ${status}` });
const message = (id, role, body) => ({ id, role, body, ownerType: mode, ownerId: "fixture", createdAt: "2026-11-01T10:00:00Z", pending: false, metadata: null, guidanceDeliveries: ["pending", "delivered", "failed", "uncertain"].map(receipt) });
const modelKey = `model-fixture:${mode}:${canvas}`;
const defaults = { model: mode === "task" ? "gpt-6.1-sol" : "gpt-6-astra", effort: "high" };
const workspace = {
  modelSettings: JSON.parse(localStorage.getItem(modelKey) || "null") || defaults,
  session: { id: "fixture", ownerType: mode, ownerId: "fixture", threadId: "saved-thread", activeTurnId: null, runState: "idle", surface: canvas ? "design" : "chat", intakeState: "ready", generation: 1, accessMode: "read-only", activeAccessMode: "read-only", accessVersion: 3, accessReason: null },
  messages: [message("user", "user", "Preserved saved history"), message("assistant", "assistant", "Preserved assistant reply"), message("system", "system", "Preserved system update")],
  pendingRequests: [], recentEvents: [], workActivities: [], design: canvas ? { document, revision: 1 } : null,
  designPages: canvas ? [{ id: "page", name: "Preserved canvas", document, revision: 1 }] : [], selectedDesignPageId: canvas ? "page" : null,
};
const controls = window.modelFixture = { errors: [], failModels: false, failSave: false, modelSaves: 0, accessCalls: 0, uploads: 0, revision: 1,
  advance() { workspace.messages[1].body = "Preserved assistant reply after poll"; this.revision++; },
};
const full = async () => ({ workspace: structuredClone(workspace), capacity: { activeTurns: 0, availableSlots: 2 }, revision: String(controls.revision), messagesRevision: String(controls.revision) });
const unread = async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } });
Object.assign(api, {
  chatModels: async () => {
    if (controls.failModels) throw new Error("Could not load models. Please retry.");
    return { models: [
      { model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", defaultReasoningEffort: "low", supportedReasoningEfforts: [{reasoningEffort:"low",description:"Faster responses"},{reasoningEffort:"high",description:"Deeper reasoning"}] },
      { model: "gpt-6-astra", displayName: "GPT-6 Astra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{reasoningEffort:"medium",description:"Balanced reasoning"},{reasoningEffort:"high",description:"Deeper reasoning"}] }
    ] };
  },
  saveChatModel: async (_mode, _id, settings) => {
    if (controls.failSave) throw new Error("Could not save. Reconnect and retry.");
    controls.modelSaves++; controls.lastModelSelection = settings;
    workspace.modelSettings = { model: settings.model, effort: settings.effort };
    localStorage.setItem(modelKey, JSON.stringify(settings)); controls.revision++;
    return { workspace: structuredClone(workspace) };
  },
  task: async () => ({ task: { id: "fixture", humanId: "LOCAL-0001", version: 1, title: "Preserved task", projectName: "Qahwa preview", status: "in_progress", comments: [], outputs: [] } }),
  workspace: full, workspacePoll: full, orchestrator: full, orchestratorPoll: full,
  taskUnread: unread, markTaskRead: unread, orchestratorUnread: unread, markOrchestratorRead: unread,
  setTaskAccess: async () => { controls.accessCalls++; throw new Error("Unexpected access mutation"); },
  uploadAttachment: async (_mode, _id, file, progress) => { controls.uploads++; progress(100); return { id: "upload", filename: file.name, mediaType: file.type, size: file.size }; },
  removeAttachment: async () => {},
  sendTaskMessage: async () => { throw new Error("Saved guidance could not be sent. Reconnect and retry."); },
  sendOrchestratorMessage: async () => { throw new Error("Saved guidance could not be sent. Reconnect and retry."); },
  clientDiagnostic: async () => {},
});
createRoot(window.document.getElementById("root")).render(<SessionWorkspace mode={mode} taskId={mode === "task" ? "fixture" : undefined} connected onError={message => controls.errors.push(message)} />);
