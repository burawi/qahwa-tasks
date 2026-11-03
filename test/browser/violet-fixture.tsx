// Isolated visual acceptance of the real PWA. No model turns or external writes.
import { createRoot } from 'react-dom/client';
import { App } from 'violet-app';
import { api, connection } from 'violet-api';
import 'violet-styles';
const stamp = new Date().toISOString();
const query = new URLSearchParams(location.search);
const projects = [{ id: 'qahwa', name: 'Qahwa Tasks', prefix: 'QAH', logo: null, rootDirectory: '/home/burawi/qahwa-tasks', taskCount: 5 }];
const names = ['A vibrant new identity for Qahwa', 'A clearer view of the work ahead', 'Keep conversations moving', 'A thoughtful home for every idea', 'Ready for your next chapter'];
const tasks = names.map((title, i) => ({ id: `task-${i}`, humanId: `QAH-000${i + 1}`, title, projectId: 'qahwa', projectName: 'Qahwa Tasks', projectPrefix: 'QAH', projectLogo: null,
  status: ['in_progress', 'in_review', 'todo', 'backlog', 'closed'][i], outcome: i === 4 ? 'completed' : null, rank: i, version: 1, unresolvedCommentCount: 0,
  smartMessage: ['Refining the details', 'Ready for your review', 'Waiting to begin', 'An idea worth exploring', 'Completed'][i], tone: ['blue', 'green', 'orange', 'neutral', 'green'][i],
  surface: 'chat', sessionState: 'idle', createdAt: stamp, updatedAt: stamp, idleNotificationsEnabled: false,
  description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vibrant violet accents, clear surfaces, and room to focus.' }] }] }, outputs: [], comments: [], relatedTasks: [],
  conversation: { activityAt: stamp, unreadCount: i === 0 ? 2 : 0, latestMessage: { role: 'assistant', preview: ['The new direction is taking shape.', 'The details are ready when you are.', 'What would you like to explore?', 'Capture a thought. Give it room to grow.', 'Everything is in place.'][i], createdAt: stamp } }
}));
const message = (id, role, body) => ({ id, role, body, ownerType: 'task', ownerId: 'task-0', metadata: null, createdAt: stamp });
let messages = [message('system', 'system', 'Workspace connected. Your conversation is private.'), message('user', 'user', 'Let’s give Qahwa a fresh perspective. Vibrant violet, with a little room to breathe.'), message('assistant', 'assistant', 'A clear direction.\n\nThe new identity brings **vibrant violet** to the places that move work forward, with calm surfaces that give every conversation room.\n\n- A distinctive Q mark\n- Light and dark themes\n- The tools you already use')];
const workspace = (mode = 'orchestrator', id = 'main') => ({ session: { id: 'session', ownerType: mode, ownerId: id, runState: 'idle', surface: 'chat', intakeState: 'ready', generation: 1 }, messages, pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [] });
const controls = window.violetFixture = { notifications: [], sends: [], state: query.get('state') || 'online', empty: query.has('empty') };
const listeners = new Set();
Object.assign(connection, { state: () => controls.state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, connect: async () => {}, profile: () => controls.state === 'unpaired' ? null : ({ serverPublicKey: 'violet-fixture', deviceId: 'browser' }) });
const unread = async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } });
const poll = async id => ({ revision: crypto.randomUUID(), messagesRevision: crypto.randomUUID(), workspace: workspace('task', id) });
Object.assign(api, {
  projects: async () => ({ projects }), devices: async () => ({ devices: [] }),
  tasks: async (scope, projectId) => ({ tasks: controls.empty ? [] : tasks.filter(t => scope === 'closed' ? t.status === 'closed' : t.status !== 'closed') }),
  task: async id => ({ task: tasks.find(t => t.id === id || t.humanId === id) }),
  workspacePoll: poll, orchestratorPoll: async () => ({ ...await poll('main'), workspace: workspace(), capacity: { activeTurns: 0, availableSlots: 3 } }),
  orchestratorSettings: async () => ({ settings: { name: 'Orchestrator', customInstructions: '' } }),
  userAvatar: async () => ({ avatar: null }), orchestratorAvatar: async () => ({ avatar: null }),
  orchestratorUnread: unread, taskUnread: unread, markTaskRead: unread, markOrchestratorRead: unread,
  setIdleNotifications: async (id, enabled) => { const task = tasks.find(t => t.id === id); task.idleNotificationsEnabled = enabled; controls.notifications.push(enabled); return { task }; },
  sendOrchestratorMessage: async body => { controls.sends.push(body); messages = [...messages, message(crypto.randomUUID(), 'user', body)]; return { workspace: workspace() }; },
  sendTaskMessage: async (_id, body) => { controls.sends.push(body); messages = [...messages, message(crypto.randomUUID(), 'user', body)]; return { workspace: workspace('task') }; },
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById('root')).render(<App />);
