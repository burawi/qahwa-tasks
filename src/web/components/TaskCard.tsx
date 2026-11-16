import type { TaskSummary } from "../../domain/types";
import { Check, Pin, Terminal } from "lucide-react";
import React, { useEffect, useRef } from "react";
import { projectColorStyle } from "../project-color";
import { ProjectLogo } from "./ProjectLogo";
import { RunningIndicator } from "./RunningIndicator";

const statusLabels = { backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", closed: "Completed" };

export function TaskCard({ task, onOpen, selectionMode = false, selected = false, onToggleSelection }: {
  task: TaskSummary; onOpen: () => void; selectionMode?: boolean; selected?: boolean; onToggleSelection?: () => void;
}) {
  const hold = useRef<{ timer?: number; pointerId: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => {
    const cancel = () => { if (hold.current) { suppressClick.current = true; cancelHold(); } };
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("blur", cancel);
    return () => { cancelHold(); window.removeEventListener("scroll", cancel, true); window.removeEventListener("blur", cancel); };
  }, []);
  const unread = task.conversation?.unreadCount ?? 0;
  const latest = task.conversation?.latestMessage;
  const activityAt = task.conversation?.activityAt ?? task.createdAt;
  const status = task.outcome === "cancelled" ? "Cancelled" : statusLabels[task.status];
  return <div className={`conversation-item${task.pinnedAt ? " is-pinned" : ""}${selectionMode ? " selection-mode" : ""}`}><button
    type="button"
    style={projectColorStyle(task.projectId)}
    className={`task-row conversation-row tone-${task.tone}${unread > 0 ? " is-unread" : ""}${selected ? " is-selected" : ""}`}
    data-task-id={task.id}
    aria-pressed={selectionMode ? selected : undefined}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) { cancelHold(); return; }
      cancelHold();
      suppressClick.current = false;
      if (!onToggleSelection) return;
      const { pointerId, clientX: x, clientY: y } = event;
      hold.current = { pointerId, x, y, timer: selectionMode ? undefined : window.setTimeout(() => {
        suppressClick.current = true;
        onToggleSelection();
      }, 500) };
    }}
    onPointerMove={(event) => {
      const current = hold.current;
      if (current && current.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) {
        suppressClick.current = true; cancelHold();
      }
    }}
    onPointerUp={cancelHold}
    onPointerCancel={() => { suppressClick.current = true; cancelHold(); }}
    onPointerLeave={() => { if (hold.current) { suppressClick.current = true; cancelHold(); } }}
    onContextMenu={(event) => { if (hold.current || suppressClick.current || selectionMode) event.preventDefault(); }}
    onClick={(event) => {
      if (event.detail > 0 && suppressClick.current) { suppressClick.current = false; return; }
      if (selectionMode) onToggleSelection?.(); else onOpen();
    }}
  >
    <span className={`conversation-avatar${task.sessionKind === "terminal" ? " has-terminal" : ""}`}>
      <ProjectLogo logo={task.projectLogo} prefix={task.projectPrefix} size="medium" />
      {task.pinnedAt && <span className="conversation-pin" role="img" aria-label="Pinned conversation" title="Pinned conversation"><Pin aria-hidden="true" /></span>}
      {task.sessionKind === "terminal" && <span className="conversation-terminal" role="img" aria-label="Terminal conversation" title="Terminal conversation"><Terminal aria-hidden="true" /></span>}
    </span>
    <span className="conversation-copy">
      <span className="conversation-heading"><strong className="conversation-title" dir="auto">{task.title}</strong><RunningIndicator running={task.sessionState === "running"} label="Task running" /></span>
      <span className="conversation-preview" dir="auto">{latest ? <>{latest.role === "user" && <span>You: </span>}{latest.preview}</> : task.sessionKind === "terminal" ? "Interactive server shell" : "No messages yet"}</span>
      {task.smartMessage && <span className="smart-status conversation-remark"><i aria-hidden="true" /><span dir="auto">{task.smartMessage}</span></span>}
      <span className="conversation-context">
        <span className="conversation-project">{task.projectName}</span>
        <span className="conversation-id">{task.humanId}</span>
        <span className="conversation-status">{status}</span>
      </span>
    </span>
    <span className="conversation-meta">
      <time dateTime={activityAt} title={new Date(activityAt).toLocaleString()}>{relativeTime(activityAt)}</time>
      {unread > 0 && <span className="conversation-unread" aria-label={`${unread} unread ${unread === 1 ? "message" : "messages"}`}>{unread > 99 ? "99+" : unread}</span>}
    </span>
  </button>{onToggleSelection && <button type="button" className={`task-selection-toggle${selected ? " selected" : ""}`} aria-label={`Select ${task.humanId}`} aria-pressed={selected} onClick={onToggleSelection}><span>{selected && <Check aria-hidden="true" />}</span></button>}</div>;
}

function relativeTime(value: string): string {
  const date = new Date(value);
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
