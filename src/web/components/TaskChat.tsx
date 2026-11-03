import { lazy, Suspense, useEffect, useState } from "react";
import type { TaskDetail } from "../../domain/types";
import { api } from "../api";

const SessionWorkspace = lazy(() => import("./SessionWorkspace").then(module => ({ default: module.SessionWorkspace })));
const TerminalWorkspace = lazy(() => import("./TerminalWorkspace").then(module => ({ default: module.TerminalWorkspace })));

/** Resolve the kind before requesting a workspace, so terminals never create a Codex session. */
export function TaskChat({ taskId, connected, foreground, onClearTaskSelection, onClose, onChanged, onError }: {
  taskId: string; connected: boolean; foreground: boolean; onClose: () => void;
  onChanged: () => void; onError: (message: string) => void;
  onClearTaskSelection?: () => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    void api.task(taskId).then(({ task }) => { if (!stopped) { setTask(task); setError(""); } })
      .catch(error => { if (!stopped) setError(error instanceof Error ? error.message : "Could not load conversation"); });
    return () => { stopped = true; };
  }, [taskId, connected, retry]);
  if (!task) return <section className="session-page"><div className="screen-loading" role="status">{error || (connected ? "Loading session…" : "Reconnect to open this conversation.")}</div><div className="button-row">{error && <button className="secondary" disabled={!connected} onClick={() => setRetry(retry + 1)}>Retry</button>}<button className="secondary" onClick={onClose}>Back</button></div></section>;
  return <Suspense fallback={<div className="screen-loading">Loading session…</div>}>
    {task.sessionKind === "terminal" ? <TerminalWorkspace task={task} connected={connected} foreground={foreground} onClose={onClose} onChanged={onChanged} onError={onError} />
      : <SessionWorkspace mode="task" taskId={taskId} connected={connected} foreground={foreground} onClearTaskSelection={onClearTaskSelection} onClose={onClose} onChanged={onChanged} onError={onError} />}
  </Suspense>;
}
