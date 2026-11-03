import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionWorkspace } from 'chat-source';
import { api } from 'chat-api';
import 'chat-styles';

const mode = new URLSearchParams(location.search).get('mode') === 'task' ? 'task' : 'orchestrator';
const stamp = '2026-10-28T10:00:00.000Z';
const messages = Array.from({ length: 240 }, (_, i) => ({
  id: `message-${i}`, ownerType: mode, ownerId: 'fixture', role: i % 3 ? 'assistant' : 'user', itemId: null, createdAt: stamp,
  body: `### Update ${i}\n\nA representative discussion with **Markdown**, [a link](https://example.com), and a checklist.\n\n- [x] Inspect the shared chat\n- [ ] Preserve typing and attachments\n\n\`\`\`ts\nconst result = await loadWorkspace();\n\`\`\`\n\n| Check | Result |\n| --- | --- |\n| History | preserved |\n\n` .repeat(2),
  metadata: i % 20 === 0 ? { attachments: [{ id: `file-${i}`, filename: `notes-${i}.txt`, size: 1200, mediaType: 'text/plain', status: 'expired', previewUrl: '/unused' }] } : null,
}));
let state = { session: { id: 'fixture', ownerType: mode, ownerId: 'fixture', runState: 'idle', surface: 'chat', intakeState: 'ready', generation: 1, createdAt: stamp, updatedAt: stamp }, messages, pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [] };
const task = { id: 'fixture', humanId: 'QAH-0012', title: 'Long chat fixture', projectName: 'Qahwa', status: 'in_progress' };
const copy = (value) => JSON.parse(JSON.stringify(value));
const controls = window.chatFixture = { polls: 0, sent: [], failSend: false, delay: 0, bytes: [], refresh: () => {}, setRunning(running) { state.session.runState = running ? 'running' : 'idle'; state.workActivities = running ? [{ id: 'live', kind: 'command', title: 'Fixture live activity', detail: 'Progress', context: null, status: 'running', startedAt: stamp, updatedAt: stamp }] : []; }, waitForAnswer() { state.session.runState = 'waiting'; state.pendingRequests = [{ id: 'question', requestType: 'user_input', payload: { questions: [{ id: 'answer', question: 'Fixture question' }] } }]; }, append() { state.messages.push({ ...messages[1], id: `new-${state.messages.length}`, body: 'New live message' }); }, edit() { state.messages[0] = { ...state.messages[0], body: 'Edited history' }; }, clear() { state.messages = []; } };
const full = async () => { controls.polls++; return { workspace: copy(state), capacity: { activeTurns: state.session.runState === 'running' ? 1 : 0, availableSlots: 2 } }; };
const poll = async (_idOrCursor, maybeCursor) => {
  controls.polls++;
  const cursor = mode === 'task' ? maybeCursor : _idOrCursor;
  const digest = value => { let hash = 2166136261; for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(16); };
  const messagesRevision = digest(state.messages);
  const revision = digest(state);
  const workspace = cursor?.revision === revision ? null : copy(state);
  if (workspace && cursor?.messagesRevision === messagesRevision) delete workspace.messages;
  const result = { workspace, revision, messagesRevision, capacity: { activeTurns: state.session.runState === 'running' ? 1 : 0, availableSlots: 2 } };
  controls.bytes.push(JSON.stringify(result).length);
  return result;
};
const send = async (...args) => { controls.sent.push(args); if (controls.delay) await new Promise(r => setTimeout(r, controls.delay)); if (controls.failSend) throw new Error('Fixture send failed'); state.messages.push({ ...messages[0], id: `sent-${state.messages.length}`, body: String(args[mode === 'task' ? 1 : 0]), metadata: null }); return full(); };
Object.assign(api, { task: async () => ({ task: copy(task) }), workspace: full, orchestrator: full, workspacePoll: poll, orchestratorPoll: poll, sendTaskMessage: send, sendOrchestratorMessage: send, clientDiagnostic: async () => {}, uploadAttachment: async (_mode, _taskId, file, progress) => { progress(50); return { id: `uploaded-${file.name}`, filename: file.name, size: file.size, mediaType: file.type, status: 'available', previewUrl: '/unused' }; }, removeAttachment: async () => {}, respondToRequest: async () => { state.pendingRequests = []; state.session.runState = 'idle'; } });
function Fixture() { const [, rerender] = useState(0); controls.refresh = () => rerender(n => n + 1); return <SessionWorkspace mode={mode} taskId={mode === 'task' ? 'fixture' : undefined} onError={message => { window.fixtureError = message; }} />; }
createRoot(document.getElementById('root')).render(<Fixture />);
