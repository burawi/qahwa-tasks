import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MessageCircle } from "lucide-react";
import type { TaskSummary } from "../../domain/types";
import { projectColorStyle } from "../project-color";

export function TaskCard({ task, draggable, onOpen }: { task: TaskSummary; draggable: boolean; onOpen: () => void }) {
  const sortable = useSortable({ id: task.id, disabled: !draggable });
  const style = {
    ...projectColorStyle(task.projectId),
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return <article
    ref={sortable.setNodeRef}
    style={style}
    className={`task-card project-accent${sortable.isDragging ? " dragging" : ""}`}
    data-task-id={task.id}
  >
    {draggable && <button className="drag-handle" type="button" aria-label={`Reorder ${task.title}`} {...sortable.attributes} {...sortable.listeners}>
      <GripVertical />
    </button>}
    <button className="task-card-main" type="button" onClick={onOpen}>
      <span className="task-id">{task.humanId}</span>
      <strong>{task.title}</strong>
      <span className="task-meta">
        <span className="project-label"><span className="project-dot" />{task.projectName}</span>
        {task.unresolvedCommentCount > 0 && <span className="comment-count"><MessageCircle />{task.unresolvedCommentCount}</span>}
        {task.status === "closed" && <span className={`outcome ${task.outcome}`}>{task.outcome}</span>}
      </span>
    </button>
  </article>;
}
