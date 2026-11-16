import React from "react";
import { createRoot } from "react-dom/client";
import { TaskCard } from "workflow-card";
import { SessionWorkspace } from "workflow-session";
import { api } from "workflow-api";
import "workflow-styles";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") === "active" ? "active" : "mixed";
const surface = params.get("surface") === "header" ? "header" : "card";
const stamp = "2026-11-16T08:00:00.000Z";
const workflow = scenario === "active"
  ? {
      state: "reviewing", label: "Reviewing", owner: "Nathem · Technical Lead", ownerActive: true,
      nextAction: "Nathem reviews the submitted evidence", blocker: null,
    }
  : {
      state: "capacity_queued", label: "Capacity queued", owner: "Task session",
      nextAction: "Resume the authorized corrections requested by Nathem. Concurrent reviews: Mohsin, Faysal continue reviewing the submitted evidence.",
      blocker: "Add the missing mixed-state workflow proof",
    };
const task = {
  id: "fixture", humanId: "QAH-0081", projectId: "qahwa", projectName: "Qahwa Tasks", projectPrefix: "QAH",
  projectLogo: null, title: "Automate review handoffs and workflow status", status: "in_review", outcome: null,
  rank: 1, unresolvedCommentCount: 0, version: 1, pinnedAt: null, sessionKind: "codex", idleNotificationsEnabled: false,
  smartMessage: "Implementation session idle", tone: "neutral", surface: "chat", sessionState: "idle", workflow,
  createdAt: stamp, updatedAt: stamp, rootDirectory: "/home/burawi/qahwa-tasks",
  description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Workflow evidence fixture" }] }] },
  comments: [], outputs: [], latestHandoff: null, relatedTasks: [],
  conversation: { activityAt: stamp, latestMessage: { role: "assistant", preview: "Validated workflow evidence is ready", createdAt: stamp }, unreadCount: 0 },
};
const workspace = {
  session: { id: "session", ownerType: "task", ownerId: "fixture", runState: "idle", surface: "chat", intakeState: "ready", generation: 1,
    createdAt: stamp, updatedAt: stamp },
  messages: [{ id: "evidence", ownerType: "task", ownerId: "fixture", role: "assistant", body: "Structured evidence is ready for specialist review.",
    metadata: null, itemId: "evidence", pending: false, createdAt: stamp }],
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
const copy = value => structuredClone(value);
const full = async () => ({ workspace: copy(workspace), capacity: { activeTurns: 0, recommendedParallelism: 4, availableSlots: 4 } });
Object.assign(api, {
  task: async () => ({ task: copy(task) }), workspace: full, workspacePoll: full,
  taskUnread: async () => ({ unreadMessageIds: [], unreadCount: 0 }),
  markTaskRead: async () => ({ unreadMessageIds: [], unreadCount: 0 }),
  clientDiagnostic: async () => {},
});

document.body.dataset.scenario = scenario;
document.body.dataset.surface = surface;
const content = surface === "header"
  ? <SessionWorkspace mode="task" taskId="fixture" connected onError={message => { window.fixtureError = message; }} />
  : <main style={{ maxWidth: "760px", margin: "0 auto", padding: "clamp(16px, 4vw, 48px)" }}>
      <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: "13px", fontWeight: 650 }}>QAH-0081 · rendered task card</p>
      <TaskCard task={task} onOpen={() => {}} />
    </main>;
createRoot(document.getElementById("root")).render(content);
