import { Bot, CheckCircle2, Circle, Clock3, Layout, MessageSquareText } from "lucide-react";
import type { TaskSummary } from "../../domain/types";
import { projectColorStyle } from "../project-color";
import { ProjectLogo } from "./ProjectLogo";

export function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const StateIcon = task.sessionState === "running" ? Bot : task.status === "closed" ? CheckCircle2 : task.sessionState === "not_started" ? Circle : Clock3;
  return <button
    type="button"
    style={projectColorStyle(task.projectId)}
    className={`task-row tone-${task.tone}`}
    data-task-id={task.id}
    onClick={onOpen}
  >
    <ProjectLogo logo={task.projectLogo} prefix={task.projectPrefix} size="small" />
    <span className="task-row-copy">
      <span className="task-row-kicker"><b>{task.humanId}</b><small>{task.projectName}</small></span>
      <strong>{task.title}</strong>
      <span className="smart-status"><i /><span>{task.smartMessage}</span></span>
    </span>
    <span className="task-row-meta">
      {task.surface === "design" ? <Layout /> : task.surface === "chat" ? <MessageSquareText /> : <StateIcon />}
      <small>{task.sessionState === "not_started" ? "Not started" : task.sessionState.replace("_", " ")}</small>
    </span>
  </button>;
}
