import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionWorkspace } from 'chat-source';
import { api } from 'chat-api';
import 'chat-styles';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'task' ? 'task' : 'orchestrator';
const stamp = '2026-10-30T10:00:00.000Z';
const workspace = {
  session: { id: 'fixture', ownerType: mode, ownerId: 'fixture', runState: 'idle', surface: 'chat', intakeState: 'ready', generation: 1, createdAt: stamp, updatedAt: stamp },
  messages: Array.from({ length: 35 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', body: `Discussion ${index}: preserve drafts and scrolling.`, createdAt: stamp, metadata: null })),
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
const controls = window.composerFixture = {
  sent: [], removed: [], failSend: false, failUploads: false, uploadDelay: 0, sendDelay: 0, connected: true,
  runOnSend: params.has('runOnSend'), activityCount: 0,
  refresh: () => {}, error: '',
};
const full = async () => ({ workspace: structuredClone(workspace), revision: String(workspace.messages.length), messagesRevision: String(workspace.messages.length) });
const send = async (...args) => {
  controls.sent.push(args);
  await new Promise(resolve => setTimeout(resolve, controls.sendDelay));
  if (controls.failSend) throw new Error('Fixture send failed');
  if (controls.runOnSend) {
    workspace.session.runState = 'running';
    workspace.workActivities = Array.from({ length: controls.activityCount }, (_, index) => ({
      id: `activity-${index}`, kind: 'command', title: `Check ${index}`, status: 'running',
      detail: 'Checking the shared composer', context: 'Details\n'.repeat(15), startedAt: stamp, updatedAt: stamp,
    }));
  }
  workspace.messages.push({ ...workspace.messages[0], id: `sent-${workspace.messages.length}`, body: String(args[mode === 'task' ? 1 : 0]) });
  return full();
};
Object.assign(api, {
  task: async () => ({ task: { id: 'fixture', humanId: 'QAH-0031', title: 'Composer fixture', projectName: 'Qahwa', status: 'in_progress' } }),
  workspacePoll: full, orchestratorPoll: full, sendTaskMessage: send, sendOrchestratorMessage: send,
  clientDiagnostic: async () => {},
  taskUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  markTaskRead: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  uploadAttachment: async (_mode, _taskId, file, progress) => {
    progress(35);
    await new Promise(resolve => setTimeout(resolve, controls.uploadDelay));
    if (controls.failUploads) throw new Error('Fixture upload failed. Remove this file and try again.');
    return { id: `uploaded-${file.name}`, filename: file.name, size: file.size, mediaType: file.type, status: 'available' };
  },
  removeAttachment: async id => { controls.removed.push(id); },
});
function Fixture() {
  const [, rerender] = useState(0);
  controls.refresh = () => rerender(value => value + 1);
  return <SessionWorkspace mode={mode} connected={controls.connected} taskId={mode === 'task' ? 'fixture' : undefined} onError={message => { controls.error = message; }} />;
}
createRoot(document.getElementById('root')).render(<Fixture />);
