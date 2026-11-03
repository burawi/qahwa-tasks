// Isolated API and storage; exercise the real App, task routing and canvas chat.
import { createRoot } from "react-dom/client";
import { App } from "reset-app";
import { api, connection } from "reset-api";
import "reset-styles";

const stamp = "2026-11-01T10:00:00.000Z";
const project = { id: "project", name: "Qahwa", prefix: "QAH", logo: null };
const tasks = ["task", "canvas"].map((id, index) => ({
  id, humanId: `QAH-900${index}`, title: `${id} submission fixture`, projectId: project.id,
  projectName: project.name, projectPrefix: project.prefix, status: "in_progress", rank: index, version: 1,
  sessionKind: "codex", sessionState: "running", surface: id === "canvas" ? "design" : "chat",
  description: { type: "doc", content: [] }, outputs: [], comments: [], relatedTasks: [],
  unresolvedCommentCount: 0, createdAt: stamp, updatedAt: stamp,
}));
const design = { id: "page", name: "Selection fixture", revision: 1, document: {
  format: "web", artboard: { width: 600, height: 300, background: "#fff", name: "Selection fixture" },
  html: '<h1 data-qahwa-id="heading">Canvas selection</h1><p data-qahwa-id="body">Canvas text selection</p>',
  css: "h1,p{margin:30px;padding:20px;color:#111;background:#eee}",
} };
const historyKey = "submission-reset-history";
const stored = JSON.parse(localStorage.getItem(historyKey) || "{}");
const controls = window.resetFixture = {
  holdSend: false, releaseSend: null, failSend: false, failPoll: false,
  holdPoll: false, pollWaiters: [], sends: [], pollsHeld: 0,
  releasePolls() { this.holdPoll = false; this.pollWaiters.splice(0).forEach(resolve => resolve()); },
};
const workspace = (ownerId = "main") => ({
  session: { id: ownerId, ownerType: ownerId === "main" ? "orchestrator" : "task", ownerId,
    runState: "running", surface: ownerId === "canvas" ? "design" : "chat", intakeState: "ready", generation: 1 },
  messages: [{ id: `source-${ownerId}`, ownerId, role: "assistant", body: "Original quoted text", createdAt: stamp, metadata: null }, ...(stored[ownerId] || [])],
  pendingRequests: [], design: ownerId === "canvas" ? design : null, designPages: ownerId === "canvas" ? [design] : [],
  selectedDesignPageId: ownerId === "canvas" ? design.id : null, recentEvents: [], workActivities: [],
});
const task = id => tasks.find(task => task.id === id || task.humanId === id);
const poll = async (ownerId = "main") => {
  if (controls.holdPoll) { controls.pollsHeld++; await new Promise(resolve => controls.pollWaiters.push(resolve)); }
  if (controls.failPoll) throw new Error("Fixture refresh failed");
  return { workspace: structuredClone(workspace(ownerId)), capacity: { activeTurns: 1, availableSlots: 1, recommendedParallelism: 2 } };
};
const send = async (ownerId, text, attachmentIds, selectedTaskIds, pageId, selectedExcerpt) => {
  const selectedTasks = selectedTaskIds.map(id => { const value = task(id); return { id, humanId: value.humanId, title: value.title }; });
  const sent = { ownerId, text, attachmentIds, selectedTaskIds, pageId, selectedExcerpt };
  controls.sends.push(sent);
  if (controls.holdSend) await new Promise(resolve => { controls.releaseSend = resolve; });
  if (controls.failSend) throw new Error("Fixture send failed");
  const message = { id: crypto.randomUUID(), ownerId, role: "user", body: text, pending: true, createdAt: stamp,
    metadata: { selectedTasks, selectedExcerpt, designPageId: pageId,
      attachments: attachmentIds.map(id => ({ id, filename: id, mediaType: "text/plain", size: 7, status: "expired" })) } };
  stored[ownerId] = [...(stored[ownerId] || []), message];
  localStorage.setItem(historyKey, JSON.stringify(stored));
  return { workspace: structuredClone(workspace(ownerId)) };
};
const unread = async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } });
Object.assign(connection, { state: () => "online", subscribe: () => () => {}, connect: async () => {},
  profile: () => ({ serverPublicKey: "reset-server", deviceId: "reset-browser" }) });
Object.assign(api, {
  projects: async () => ({ projects: [project] }), tasks: async () => ({ tasks }),
  task: async id => ({ task: task(id) }),
  workspacePoll: async id => poll(task(id).id), orchestratorPoll: async () => poll(),
  sendTaskMessage: async (id, text, ids, pageId, excerpt) => send(task(id).id, text, ids, [], pageId, excerpt),
  sendOrchestratorMessage: async (text, ids, selectedIds, excerpt) => send("main", text, ids, selectedIds, null, excerpt),
  taskUnread: unread, orchestratorUnread: unread, markTaskRead: unread, markOrchestratorRead: unread,
  uploadAttachment: async (_mode, _id, file, progress) => { progress(100); return { id: file.name, filename: file.name, mediaType: file.type, size: file.size, status: "available" }; },
  removeAttachment: async () => {}, clientDiagnostic: async () => {},
  userAvatar: async () => ({ avatar: null }), orchestratorAvatar: async () => ({ avatar: null }),
});
createRoot(document.getElementById("root")).render(<App />);
