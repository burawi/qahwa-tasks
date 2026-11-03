import { createRoot } from "react-dom/client";
import { App } from "title-app";
import { api, connection } from "title-api";
import { fallbackTaskTitle } from "title-fallback";
import "title-styles";

const stamp = new Date().toISOString();
const project = { id: "project", name: "Task titles", prefix: "TTL", logo: null, archivedAt: null };
const base = { projectId: project.id, projectName: project.name, projectPrefix: project.prefix, projectLogo: null,
  status: "backlog", outcome: null, rank: 1, version: 1, unresolvedCommentCount: 0, smartMessage: "Not started",
  surface: "chat", tone: "neutral", sessionState: "not_started", createdAt: stamp, updatedAt: stamp };
const tasks = [{ ...base, id: "manual", humanId: "TTL-0001", title: "Keep my deliberate title" }];
const controls = window.titleFixture = {
  payload: null,
  complete(title) { tasks.find(task => task.id === "captured").title = title; },
};
Object.assign(connection, { state: () => "online", subscribe: () => () => {}, connect: async () => {} });
Object.assign(api, {
  projects: async () => ({ projects: [project] }),
  tasks: async () => ({ tasks: tasks.map(task => ({ ...task })) }),
  createTask: async payload => {
    controls.payload = payload;
    const note = payload.description.content.map(block => block.content?.map(node => node.text).join("") ?? "").join("\n");
    const task = { ...base, id: "captured", humanId: "TTL-0002", title: fallbackTaskTitle(note) };
    tasks.push(task);
    return { task };
  },
  orchestratorUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  orchestratorSettings: async () => ({ settings: { name: "Moeen" } }),
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<App />);
