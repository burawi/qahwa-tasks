import type { SelectedTaskReference } from "../../domain/types";
import { Pin, PinOff } from "lucide-react";

export function TaskSelection({ tasks, onClear, onRemove, onDiscuss, onPin, pinDisabled = false, orchestratorName = "Orchestrator" }: {
  tasks: SelectedTaskReference[];
  onClear: () => void;
  onRemove: (task: SelectedTaskReference) => void;
  onDiscuss?: () => void;
  onPin?: (pinned: boolean) => void;
  pinDisabled?: boolean;
  orchestratorName?: string;
}) {
  return <section className="task-selection" aria-label="Selected tasks">
    <div className="task-selection-heading">
      <strong role="status">{tasks.length ? `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} selected` : "No tasks selected"}</strong>
      {tasks.length > 0 && <div>{onPin && <><button type="button" disabled={pinDisabled} aria-label="Pin selected conversations" onClick={() => onPin(true)}><Pin aria-hidden="true" />Pin</button><button type="button" disabled={pinDisabled} aria-label="Unpin selected conversations" onClick={() => onPin(false)}><PinOff aria-hidden="true" />Unpin</button></>}{onDiscuss && <button type="button" onClick={onDiscuss}>Talk to {orchestratorName}</button>}<button type="button" onClick={onClear}>Clear selection</button></div>}
    </div>
    {tasks.length > 0 ? <ul>{tasks.map((task) => <li key={task.id}><span><b>{task.humanId}</b> {task.title}</span><button type="button" aria-label={`Deselect ${task.humanId}`} onClick={() => onRemove(task)}>×</button></li>)}</ul>
      : <p>Hold a task or use its selection control to add context to your next message.</p>}
  </section>;
}
