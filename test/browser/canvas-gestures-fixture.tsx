// The real task workspace, isolated from production data and agent turns.
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const stamp = "2026-10-30T10:00:00.000Z";
const document = {
  format: "web",
  artboard: { name: "Gesture reference", width: 1600, height: 1200, background: "#f5efff" },
  html: '<main data-qahwa-id="page"><button data-qahwa-id="target">Select this element</button><div data-qahwa-id="end">Artboard end</div></main>',
  css: 'body{font:24px sans-serif}main{position:relative;width:1600px;height:1200px;background:linear-gradient(135deg,#eee0ff,#a78bfa)}button{position:absolute;left:80px;top:80px;width:240px;height:100px;font:24px sans-serif}[data-qahwa-id="end"]{position:absolute;right:20px;bottom:20px}',
};
const state = JSON.parse(sessionStorage.getItem("canvas-pages") || "null") || {
  session: { id: "fixture", ownerType: "task", ownerId: "fixture", runState: "idle", surface: "design", intakeState: "ready", generation: 1 },
  messages: Array.from({ length: 20 }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? "assistant" : "user", body: `Message ${i + 1}. Canvas navigation must preserve normal chat scrolling.`, metadata: null, ownerType: "task", ownerId: "fixture", createdAt: stamp })),
  design: { id: "design", revision: 1, document },
  selectedDesignPageId: "current",
  designPages: [
    { id: "current", name: "Gesture reference", revision: 1, document },
    { id: "saved", name: "Saved layout", revision: 2, document: { ...document, artboard: { ...document.artboard, name: "Saved reference", width: 600, height: 800 } } },
    { id: "tall", name: "Tall artboard", revision: 3, document: { ...document, artboard: { ...document.artboard, name: "Tall reference", width: 600, height: 30000 } } },
  ],
  pendingRequests: [], recentEvents: [], workActivities: [],
};
window.canvasFixture = {
  polls: 0, read: [],
  run() {
    state.session.runState = "running";
    state.workActivities = Array.from({ length: 20 }, (_, i) => ({ id: `work-${i}`, kind: "command", title: `Check ${i + 1}`, status: "running", detail: "Browser validation", context: null, startedAt: stamp, updatedAt: stamp }));
  },
  idle() { state.session.runState = "idle"; state.workActivities = []; },
};
const unread = () => {
  const ids = state.messages.filter(message => message.role === "assistant" && !window.canvasFixture.read.includes(message.id)).map(message => message.id);
  return { readState: { unreadCount: ids.length, unreadMessageIds: ids } };
};
const persistPages = () => sessionStorage.setItem("canvas-pages", JSON.stringify(state));
Object.assign(api, {
  selectDesignPage: async (_id, pageId) => {
    state.selectedDesignPageId = pageId;
    state.design = state.designPages.find(page => page.id === pageId);
    persistPages();
  },
  createDesignPage: async (_id, name) => {
    const page = { id: `page-${state.designPages.length}`, name, revision: 1, document: { format: "web", artboard: { ...document.artboard, name }, html: "", css: "" } };
    state.designPages.push(page); state.selectedDesignPageId = page.id; state.design = page; persistPages();
  },
  renameDesignPage: async (_id, id, name) => { state.designPages.find(page => page.id === id).name = name; persistPages(); },
  task: async () => ({ task: { id: "fixture", humanId: "QAH-0024", title: "Canvas navigation", projectName: "Qahwa", status: "in_progress" } }),
  workspacePoll: async () => ({ workspace: structuredClone(state), revision: String(++window.canvasFixture.polls), messagesRevision: "1" }),
  taskUnread: async () => unread(),
  markTaskRead: async (_id, ids) => { window.canvasFixture.read.push(...ids); return unread(); },
  clientDiagnostic: async () => {},
});
createRoot(window.document.getElementById("root")).render(<SessionWorkspace mode="task" taskId="fixture" onError={message => { window.fixtureError = message; }} />);
