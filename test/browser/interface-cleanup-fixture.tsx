import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "cleanup-source";
import { api } from "cleanup-api";
import "cleanup-styles";
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "orchestrator" ? "orchestrator" : "task";
const canvas = params.get("mode") === "canvas";
const document = { format: "web", artboard: { width: 390, height: 500, background: "#fff", name: "Preserved canvas" }, html: '<main data-qahwa-id="preserved">Preserved canvas content</main>', css: "main{padding:24px;color:#533193}" };
const receipt = status => ({ messageId: `guidance-${status}`, taskId: "fixture", taskTitle: "Preserved task", status, detail: `Internal receipt detail ${status}` });
const message = (id, role, body) => ({ id, role, body, ownerType: mode, ownerId: "fixture", createdAt: "2026-11-01T10:00:00Z", pending: false, metadata: null, guidanceDeliveries: ["pending", "delivered", "failed", "uncertain"].map(receipt) });
const workspace = {
  session: { id: "fixture", ownerType: mode, ownerId: "fixture", threadId: "saved-thread", activeTurnId: null, runState: "idle", surface: canvas ? "design" : "chat", intakeState: "ready", generation: 1, accessMode: "read-only", activeAccessMode: "read-only", accessVersion: 3, accessReason: null },
  messages: [message("user", "user", "Preserved saved history"), message("assistant", "assistant", "Preserved assistant reply"), message("system", "system", "Preserved system update")],
  pendingRequests: [], recentEvents: [], workActivities: [], design: canvas ? { document, revision: 1 } : null,
  designPages: canvas ? [{ id: "page", name: "Preserved canvas", document, revision: 1 }] : [], selectedDesignPageId: canvas ? "page" : null,
};
const controls = window.cleanupFixture = { errors: [], accessCalls: 0, uploads: 0, revision: 1,
  advance() { workspace.messages[1].body = "Preserved assistant reply after poll"; this.revision++; },
};
const full = async () => ({ workspace: structuredClone(workspace), capacity: { activeTurns: 0, availableSlots: 2 }, revision: String(controls.revision), messagesRevision: String(controls.revision) });
const unread = async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } });
Object.assign(api, {
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
