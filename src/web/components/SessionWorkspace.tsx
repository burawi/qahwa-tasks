import { ArrowLeft, Bot, Eraser, Info, Maximize2, Minus, Network, Pause, Play, Plus, Send, Sparkles, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { TaskDetail, TaskWorkspace } from "../../domain/types";
import { api } from "../api";
import { TaskDetail as TaskDetailPanel } from "./TaskDetail";

interface Props {
  mode: "task" | "orchestrator";
  taskId?: string;
  onClose?: () => void;
  onNavigateTask?: (humanId: string) => void;
  onChanged?: () => void;
  onError: (message: string) => void;
}

export function SessionWorkspace({ mode, taskId, onClose, onNavigateTask, onChanged, onError }: Props) {
  const [workspace, setWorkspace] = useState<TaskWorkspace | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [capacity, setCapacity] = useState<{ activeTurns: number; recommendedParallelism: number; availableSlots: number } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [selectedDesignElement, setSelectedDesignElement] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (mode === "task" && taskId) {
      const [taskResult, workspaceResult] = await Promise.all([api.task(taskId), api.workspace(taskId)]);
      setTask(taskResult.task);
      setWorkspace(workspaceResult.workspace);
    } else {
      const result = await api.orchestrator();
      setWorkspace(result.workspace);
      setCapacity(result.capacity);
    }
  };

  useEffect(() => {
    void load().catch((error) => onError(error instanceof Error ? error.message : "Could not load session"));
    const timer = window.setInterval(() => void load().catch(() => undefined), 1500);
    return () => window.clearInterval(timer);
  }, [mode, taskId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [workspace?.messages.length]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); await load(); onChanged?.(); }
    catch (error) { onError(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    setMessage("");
    const contextual = selectedDesignElement ? `${text}\n\nSelected canvas element: ${selectedDesignElement}` : text;
    void act(() => mode === "task" && taskId ? api.sendTaskMessage(taskId, contextual) : api.sendOrchestratorMessage(contextual));
  };
  const running = workspace?.session.runState === "running" || workspace?.session.runState === "waiting";

  return <section className={mode === "task" ? "session-page" : "orchestrator-page"}>
    <header className="session-header">
      {onClose && <button type="button" className="icon-button" onClick={onClose} aria-label="Back"><ArrowLeft /></button>}
      <span className={`session-avatar ${mode}`} aria-hidden="true">{mode === "task" ? <Bot /> : <Network />}</span>
      <div className="session-title">
        <span>{mode === "task" ? task?.humanId ?? "Task" : "Orchestrator"}</span>
        <strong>{mode === "task" ? task?.title ?? "Loading…" : "Portfolio coordination"}</strong>
        <small>{mode === "task" ? task?.projectName ?? "" : "A calm view across every task"}</small>
      </div>
      {mode === "task" && workspace && <span className={`session-state run-${workspace.session.runState}`}><i />{workspace.session.runState === "not_started" ? "Not started" : workspace.session.runState}</span>}
      {mode === "orchestrator" && capacity && <span className="capacity-pill"><i />{capacity.activeTurns} active <b>·</b> {capacity.availableSlots} available</span>}
      {mode === "task" && <button type="button" className="icon-button" onClick={() => setShowDetails(true)} aria-label="Task details"><Info /></button>}
      {running && <button type="button" className="icon-button warning" disabled={busy} onClick={() => void act(() => mode === "task" && taskId ? api.interruptTask(taskId) : api.interruptOrchestrator())} aria-label="Interrupt"><Pause /></button>}
      {mode === "orchestrator" && <button type="button" className="icon-button" disabled={busy || running} onClick={() => {
        if (window.confirm("Clean the orchestrator chat and start a fresh session?")) void act(() => api.cleanOrchestrator());
      }} aria-label="Clean orchestrator"><Eraser /></button>}
    </header>

    {mode === "task" && workspace?.session.surface === "design" && workspace.design && <DesignCanvas workspace={workspace} onSelect={setSelectedDesignElement} />}
    {mode === "task" && task && task.status !== "closed" && task.status !== "backlog" && <div className="session-actions">
      <span>{task.status.replace("_", " ")}</span>
      {task.status === "in_review" && <button type="button" className="primary" disabled={busy || running} onClick={() => void act(() => api.transition(task.id, "closed", "completed"))}>Mark completed</button>}
      <button type="button" className="danger-subtle" disabled={busy || running} onClick={() => {
        if (window.confirm("Cancel this task?")) void act(() => api.transition(task.id, "closed", "cancelled"));
      }}>Cancel task</button>
    </div>}

    <div className="chat-stream">
      {workspace?.messages.length === 0 && <div className="session-empty"><span className="empty-orb">{mode === "task" ? <Sparkles /> : <Network />}</span><span className="empty-kicker">{mode === "task" ? "Dedicated session" : "One clear overview"}</span><h2>{mode === "task" ? "Ready when you are" : "Plan the work, not every move"}</h2><p>{mode === "task" ? "Start this task when you want its session to understand the note, ask what is missing, and choose between a focused chat or design canvas." : "Discuss priorities, dependencies, and what can safely run together. The orchestrator watches progress and speaks up when something matters."}</p></div>}
      {workspace?.messages.map((entry) => <article key={entry.id} className={`chat-message ${entry.role}`}>
        <span className="message-avatar" aria-hidden="true">{entry.role === "user" ? <UserRound /> : entry.role === "assistant" ? mode === "task" ? <Bot /> : <Network /> : <Info />}</span>
        <div className="message-content"><div className="message-role">{entry.role === "assistant" ? mode === "task" ? "Task session" : "Orchestrator" : entry.role === "user" ? "You" : "System"}<time>{formatMessageTime(entry.createdAt)}</time></div>
        <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          img: ({ ...props }) => <a href={props.src} target="_blank" rel="noreferrer"><img {...props} loading="lazy" /></a>,
        }}>{entry.body}</ReactMarkdown></div></div>
      </article>)}
      {running && <div className="working-indicator"><span /><span /><span />{workspace?.session.runState === "waiting" ? "Waiting for you" : "Working"}</div>}
      {workspace?.pendingRequests.map((pending) => <PendingCard key={pending.id} pending={pending} onResolve={(body) => void act(() => api.respondToRequest(pending.id, body))} />)}
      <div ref={endRef} />
    </div>

    <form className="chat-composer" onSubmit={submit}>
      {mode === "task" && task?.status === "closed" ? <div className="closed-composer">Task {task.outcome}</div> : mode === "task" && workspace?.session.runState === "not_started" ? <button className="primary trigger-button" type="button" disabled={busy} onClick={() => taskId && void act(() => api.triggerTask(taskId))}><Play /> Trigger task</button> : <>
        <div className="composer-field">{selectedDesignElement && <span className="canvas-selection">Canvas · {selectedDesignElement}<button type="button" onClick={() => setSelectedDesignElement(null)} aria-label="Clear selection"><X /></button></span>}<textarea aria-label="Message" placeholder={running ? "This session is working…" : mode === "task" ? "Ask, clarify, or guide this task…" : "Discuss priorities or ask for an update…"} value={message} onChange={(event) => setMessage(event.target.value)} disabled={running || busy} rows={1} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} /></div>
        <button className="send-button" type="submit" disabled={running || busy || !message.trim()} aria-label="Send"><Send /></button>
      </>}
    </form>
    {showDetails && taskId && <TaskDetailPanel
      taskId={taskId}
      onClose={() => setShowDetails(false)}
      onNavigate={(humanId) => { setShowDetails(false); onNavigateTask?.(humanId); }}
      onChanged={() => { void load(); onChanged?.(); }}
      onError={onError}
    />}
  </section>;
}

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DesignCanvas({ workspace, onSelect }: { workspace: TaskWorkspace; onSelect: (selection: string | null) => void }) {
  const [zoom, setZoom] = useState(0.75);
  const [versionId, setVersionId] = useState("current");
  const design = workspace.design!;
  const selectedVersion = workspace.designVersions.find((version) => version.id === versionId);
  const document = selectedVersion?.document ?? design.document;
  const displayedRevision = selectedVersion?.revision ?? design.revision;
  const source = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:${document.artboard.background}}[data-qahwa-id]{cursor:pointer}[data-qahwa-selected]{outline:3px solid #2563eb!important;outline-offset:2px}${document.css}</style></head><body>${document.html}<script>document.addEventListener('click',function(event){var target=event.target.closest('[data-qahwa-id]');if(!target)return;event.preventDefault();document.querySelectorAll('[data-qahwa-selected]').forEach(function(node){node.removeAttribute('data-qahwa-selected')});target.setAttribute('data-qahwa-selected','');parent.postMessage({type:'qahwa-canvas-select',id:target.getAttribute('data-qahwa-id'),tag:target.tagName.toLowerCase(),text:(target.textContent||'').trim().slice(0,120)},'*')})<\/script></body></html>`;
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const value = event.data as { type?: string; id?: string; tag?: string; text?: string };
      if (value?.type === "qahwa-canvas-select" && value.id) onSelect(`${value.id} (${value.tag ?? "element"})${value.text ? `: ${value.text}` : ""}`);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onSelect]);
  return <section className="design-panel">
    <header><div><strong>{document.artboard.name}</strong><small>Revision {displayedRevision} · {document.artboard.width}×{document.artboard.height}</small></div>{workspace.designVersions.length > 0 && <select aria-label="Canvas version" value={versionId} onChange={(event) => { setVersionId(event.target.value); onSelect(null); }}><option value="current">Current</option>{workspace.designVersions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select>}<div className="canvas-controls"><button type="button" onClick={() => setZoom(Math.max(.25, zoom - .1))} aria-label="Zoom out"><Minus /></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom(Math.min(1.5, zoom + .1))} aria-label="Zoom in"><Plus /></button><button type="button" onClick={() => setZoom(.75)} aria-label="Fit canvas"><Maximize2 /></button></div></header>
    <div className="design-stage"><iframe title={document.artboard.name} sandbox="allow-scripts" srcDoc={source} style={{ width: document.artboard.width * zoom, height: document.artboard.height * zoom }} /></div>
  </section>;
}

function PendingCard({ pending, onResolve }: { pending: TaskWorkspace["pendingRequests"][number]; onResolve: (body: { approved?: boolean; answers?: Record<string, string> }) => void }) {
  if (pending.requestType === "user_input") {
    const questions = Array.isArray(pending.payload.questions) ? pending.payload.questions as Array<Record<string, unknown>> : [];
    return <form className="pending-card" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      onResolve({ answers: Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value)])) });
    }}><strong>Codex needs clarification</strong>{questions.map((question, index) => {
      const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
      return <label key={String(question.id ?? index)}>{String(question.question ?? question.header ?? "Answer")}{options.length ? <select name={String(question.id ?? index)} required defaultValue=""><option value="" disabled>Choose…</option>{options.map((option) => <option key={String(option.label)} value={String(option.label)}>{String(option.label)}</option>)}</select> : <input name={String(question.id ?? index)} required />}</label>;
    })}<button className="primary" type="submit">Send answers</button></form>;
  }
  return <div className="pending-card"><strong>Approval requested</strong><p>{String(pending.payload.reason ?? pending.payload.command ?? pending.payload.method ?? "Codex requested permission to continue.")}</p><div className="button-row"><button className="secondary" type="button" onClick={() => onResolve({ approved: false })}>Deny</button><button className="primary" type="button" onClick={() => onResolve({ approved: true })}>Approve once</button></div></div>;
}
