import { ArrowUpRight, Bot, CheckCircle2, Circle, Clock3, Layout, MessageSquareText } from "lucide-react";
import type { TaskSummary } from "../../domain/types";
import { projectColorStyle } from "../project-color";
import { ProjectLogo } from "./ProjectLogo";

export function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const StateIcon = task.sessionState === "running" ? Bot : task.status === "closed" ? CheckCircle2 : task.sessionState === "not_started" ? Circle : Clock3;
  const activity = task.lastActivityAt ? relativeTime(task.lastActivityAt) : "No activity";
  return <button
    type="button"
    style={projectColorStyle(task.projectId)}
    className={`task-row tone-${task.tone}`}
    data-task-id={task.id}
    onClick={onOpen}
  >
    <span className="task-tone-rail" />
    <ProjectLogo logo={task.projectLogo} prefix={task.projectPrefix} size="medium" />
    <span className="task-row-copy">
      <span className="task-row-kicker"><b>{task.projectName}</b><i /> <small>{task.humanId}</small></span>
      <strong>{task.title}</strong>
      <span className="smart-status"><i /><span>{task.smartMessage}</span><small>{activity}</small></span>
    </span>
    <span className="task-row-meta">
      <span>{task.surface === "design" ? <Layout /> : task.surface === "chat" ? <MessageSquareText /> : <StateIcon />}</span>
      <small>{task.surface === "design" ? "Canvas" : task.surface === "chat" ? "Chat" : task.sessionState === "not_started" ? "Ready" : task.sessionState.replace("_", " ")}</small>
      <ArrowUpRight className="task-open-icon" />
    </span>
  </button>;
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
