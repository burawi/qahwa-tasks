import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "task" ? "task" : "orchestrator";
const stamp = "2026-10-30T10:00:00.000Z";
const key = `block-copy-${mode}`;
const initial = {
  session: { id: "fixture", ownerType: mode, ownerId: "fixture", runState: "running", surface: "chat", intakeState: "ready", generation: 1 },
  messages: [
    { id: "plain", role: "user", body: "Plain text with repeated words: repeated words." },
    { id: "formatted", role: "assistant", body: "A **formatted excerpt** with *emphasis* and [a link](https://example.com).\n\nSecond paragraph.\n\n- First item\n- Second item\n\n```ts\nconst exact = true;\n```\n\n| Name | Value |\n| --- | --- |\n| Example | preserved |" },
    { id: "duplicate", role: "assistant", body: "A **formatted excerpt** with *emphasis* and [a link](https://example.com)." },
    { id: "system", role: "system", body: "### System info\n\nExpanded selectable system details." },
  ].map(entry => ({ ...entry, ownerType: mode, ownerId: "fixture", createdAt: stamp, metadata: null, itemId: null })),
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
initial.messages.push(...[
  { id: "quote", role: "assistant", body: "> First **bold** line\n> second line  \n> third line\n>\n> Next paragraph with `inline`.\n>\n> > Nested quote\n> > nested second line" },
  { id: "code", role: "assistant", body: "```python\ndef greet():\n\tprint(\"مرحبا 🌿\")\n\n    return 42  \n```\n\n```\n  plain\n    indented\n```\n\n    indented_code()\n        next_line()\n\n```json\n{\n  \"long\": \"" + "x".repeat(180) + "\"\n}\n```" },
  { id: "mixed", role: "assistant", body: "> Before\n>\n> ```ts\n>   const nested = true;\n> ```\n>\n> After" },
  { id: "stream", role: "assistant", body: "```js\n  streamed" },
  { id: "reply", role: "user", body: "Reply body", metadata: { selectedExcerpt: { messageId: "quote", role: "assistant", excerpt: "  Exact reply\n\twith tabs\n\nمرحبا 🌿  " } } },
].map(entry => ({ ...entry, ownerType: mode, ownerId: "fixture", createdAt: stamp, itemId: null })));
let state = structuredClone(initial);
const persist = () => localStorage.setItem(key, JSON.stringify(state));
const controls = window.excerptFixture = { fail: false, failPoll: false, connected: true, taskId: "fixture", sent: [], refresh: () => {},
  reset() { state = structuredClone(initial); persist(); },
  stream() { state.messages.find(entry => entry.id === "stream").body = "```js\n  streamed\n    complete();\n```"; },
  append() { state.messages.push({ ...state.messages[1], id: crypto.randomUUID() }); },
};
const full = async () => {
  if (controls.failPoll) throw new Error("Fixture refresh failed");
  return { workspace: structuredClone(state), capacity: { activeTurns: 1, availableSlots: 0 } };
};
const send = async (...args) => {
  controls.sent.push(args);
  if (controls.fail) throw new Error("Fixture send failed");
  const selectedExcerpt = args[mode === "task" ? 4 : 3];
  const ids = args[mode === "task" ? 2 : 1];
  state.messages.push({ id: crypto.randomUUID(), role: "user", ownerType: mode, ownerId: "fixture", body: args[mode === "task" ? 1 : 0], createdAt: stamp, pending: true,
    metadata: { selectedExcerpt, attachments: ids.map(id => ({ id, filename: id, mediaType: "text/plain", size: 7, status: "expired" })) } });
  persist(); return { workspace: structuredClone(state) };
};
Object.assign(api, {
  task: async () => ({ task: { id: controls.taskId, humanId: "QAH-0021", title: "Copy blocks", projectName: "Qahwa", status: "in_progress" } }),
  workspacePoll: full, orchestratorPoll: full, sendTaskMessage: send, sendOrchestratorMessage: send,
  taskUnread: async () => ({ readState: { unreadMessageIds: [], unreadCount: 0 } }), markTaskRead: async () => ({}), clientDiagnostic: async () => {},
  uploadAttachment: async (_mode, _id, file, progress) => { progress(100); return { id: file.name, filename: file.name, mediaType: file.type, size: file.size, status: "available" }; },
  removeAttachment: async () => {},
  voiceAvailable: async () => ({ available: true }),
  startVoiceTranscription: async () => ({ transcription: { id: "voice-job", status: "complete", text: "Voice reply" } }),
  cancelVoiceTranscription: async () => {},
});
function Fixture() {
  const [, refresh] = useState(0);
  controls.refresh = () => refresh(n => n + 1);
  return <SessionWorkspace mode={mode} connected={controls.connected} taskId={mode === "task" ? controls.taskId : undefined}
    selectedTasks={mode === "orchestrator" ? [{ id: "selected-task", humanId: "QAH-9999", title: "Selection context" }] : []}
    onError={message => { window.fixtureError = message; }} />;
}
createRoot(document.getElementById("root")).render(<Fixture />);
