import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";
const stamp = new Date().toISOString();
const controls = window.voiceFixture = { sent: [], stopped: 0, failSend: false, failTranscription: false, available: true, deferUpload: false, uploads: [], removed: [], cancelled: [], native: false, connected: true, scope: "first", show: true, update: () => {} };
let serial = 0;
const workspace = { session: { runState: "idle", surface: "chat", intakeState: "ready" }, messages: [], pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, workActivities: [] };
const full = async () => ({ workspace: structuredClone(workspace), revision: "1", messagesRevision: "1", capacity: { activeTurns: 0, availableSlots: 2 } });
const send = async (...args) => { controls.sent.push(args); await new Promise(resolve => setTimeout(resolve, 150)); if (controls.failSend) throw new Error("Send failed"); return full(); };
Object.assign(api, {
  task: async () => ({ task: { id: controls.scope, humanId: "VOC-0001", title: "Voice messages", status: "in_progress", projectName: "Qahwa" } }),
  workspacePoll: full, orchestratorPoll: full, sendTaskMessage: send, sendOrchestratorMessage: send,
  taskUnread: async () => ({ readState: { unreadMessageIds: [] } }), markTaskRead: async () => ({}), clientDiagnostic: async () => {},
  voiceAvailable: async () => ({ available: controls.available }),
  uploadAttachment: async (_mode, _id, file) => {
    controls.uploads.push(file);
    if (controls.deferUpload) await new Promise(resolve => { controls.finishUpload = resolve; });
    return { id: `upload-${++serial}`, filename: file.name, size: file.size, mediaType: file.type, status: "available", previewUrl: "/unused" };
  },
  removeAttachment: async id => { controls.removed.push(id); },
  startVoiceTranscription: async () => ({ transcription: { id: `job-${serial}`, status: "processing" } }),
  voiceTranscription: async id => ({ transcription: controls.failTranscription ? { id, status: "failed", error: "Transcription failed. Please retry." } : { id, status: "complete", text: "Bonjour, مرحبا, hello." } }),
  cancelVoiceTranscription: async id => { controls.cancelled.push(id); },
});
const mode = new URLSearchParams(location.search).get("mode") === "task" ? "task" : "orchestrator";
function Fixture() {
  const [, update] = useState(0); controls.update = () => update(n => n + 1);
  return controls.show && <SessionWorkspace mode={mode} taskId={mode === "task" ? controls.scope : undefined} connected={controls.connected} onError={error => { controls.error = error; }} />;
}
createRoot(document.getElementById("root")).render(<Fixture />);
