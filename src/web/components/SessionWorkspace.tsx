import { AlertCircle, ArrowLeft, Bot, BrainCircuit, Check, ChevronDown, ChevronUp, CircleCheck, Code2, Eraser, Expand, FilePenLine, Info, LoaderCircle, Maximize2, Minus, Network, Pause, Play, Plus, RotateCcw, Save, Search, Send, Shrink, Sparkles, Terminal, UserRound, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { TaskDetail, TaskWorkspace, WorkActivity } from "../../domain/types";
import { api } from "../api";

const TaskDetailPanel = lazy(() => import("./TaskDetail").then((module) => ({ default: module.TaskDetail })));

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
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [workspace?.messages.length, workspace?.workActivities.at(-1)?.updatedAt]);

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
      {mode === "task" && workspace && <span className={`session-state run-${workspace.session.runState}`}><i />{workspace.session.intakeState === "pending" && workspace.session.runState !== "not_started" ? "Clarifying scope" : workspace.session.runState === "not_started" ? "Not started" : workspace.session.runState}</span>}
      {mode === "orchestrator" && capacity && <span className="capacity-pill"><i />{capacity.activeTurns} active <b>·</b> {capacity.availableSlots} available</span>}
      {mode === "task" && <button type="button" className="icon-button" onClick={() => setShowDetails(true)} aria-label="Task details"><Info /></button>}
      {running && <button type="button" className="icon-button warning" disabled={busy} onClick={() => void act(() => mode === "task" && taskId ? api.interruptTask(taskId) : api.interruptOrchestrator())} aria-label="Interrupt"><Pause /></button>}
      {mode === "orchestrator" && <button type="button" className="icon-button" disabled={busy || running} onClick={() => {
        if (window.confirm("Clean the orchestrator chat and start a fresh session?")) void act(() => api.cleanOrchestrator());
      }} aria-label="Clean orchestrator"><Eraser /></button>}
    </header>

    {mode === "task" && taskId && workspace?.session.surface === "design" && workspace.design && <DesignCanvas workspace={workspace} taskId={taskId} onSelect={setSelectedDesignElement} onChanged={load} onError={onError} />}
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
          a: ({ href, ...props }) => <a {...props} href={href} target="_blank" rel="noopener noreferrer external" onClick={(event) => { if (!href) return; event.preventDefault(); window.open(href, "_blank", "noopener,noreferrer"); }} />,
          img: ({ ...props }) => <a href={props.src} target="_blank" rel="noopener noreferrer external" onClick={(event) => { if (!props.src) return; event.preventDefault(); window.open(props.src, "_blank", "noopener,noreferrer"); }}><img {...props} loading="lazy" /></a>,
        }}>{entry.body}</ReactMarkdown></div></div>
      </article>)}
      {workspace && (workspace.workActivities.length > 0 || running) && <WorkLog activities={workspace.workActivities} running={running} waiting={workspace.session.runState === "waiting"} />}
      {workspace?.pendingRequests.map((pending) => <PendingCard key={pending.id} pending={pending} onResolve={(body) => void act(() => api.respondToRequest(pending.id, body))} />)}
      <div ref={endRef} />
    </div>

    <form className="chat-composer" onSubmit={submit}>
      {mode === "task" && task?.status === "closed" ? <div className="closed-composer">Task {task.outcome}</div> : mode === "task" && workspace?.session.runState === "not_started" ? <button className="primary trigger-button" type="button" disabled={busy} onClick={() => taskId && void act(() => api.triggerTask(taskId))}><Play /> Clarify &amp; start</button> : <>
        <div className="composer-field">{selectedDesignElement && <span className="canvas-selection">Canvas · {selectedDesignElement}<button type="button" onClick={() => setSelectedDesignElement(null)} aria-label="Clear selection"><X /></button></span>}<textarea aria-label="Message" placeholder={running ? "This session is working…" : mode === "task" ? "Ask, clarify, or guide this task…" : "Discuss priorities or ask for an update…"} value={message} onChange={(event) => setMessage(event.target.value)} disabled={running || busy} rows={1} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} /></div>
        <button className="send-button" type="submit" disabled={running || busy || !message.trim()} aria-label="Send"><Send /></button>
      </>}
    </form>
    {showDetails && taskId && <Suspense fallback={<div className="screen-loading">Loading details…</div>}><TaskDetailPanel
      taskId={taskId}
      onClose={() => setShowDetails(false)}
      onNavigate={(humanId) => { setShowDetails(false); onNavigateTask?.(humanId); }}
      onChanged={() => { void load(); onChanged?.(); }}
      onError={onError}
    /></Suspense>}
  </section>;
}

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DesignCanvas({ workspace, taskId, onSelect, onChanged, onError }: { workspace: TaskWorkspace; taskId: string; onSelect: (selection: string | null) => void; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [zoom, setZoom] = useState(0.75);
  const [versionId, setVersionId] = useState("current");
  const [fullscreen, setFullscreen] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ mode: "pan" | "pinch"; distance: number; x: number; y: number; left: number; top: number; zoom: number } | null>(null);
  const design = workspace.design!;
  const selectedVersion = workspace.designVersions.find((version) => version.id === versionId);
  const document = selectedVersion?.document ?? design.document;
  const displayedRevision = selectedVersion?.revision ?? design.revision;
  const source = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>html,body{margin:0;min-height:100%;background:${document.artboard.background};touch-action:none;overscroll-behavior:none}[data-qahwa-id]{cursor:pointer}[data-qahwa-selected]{outline:3px solid #2563eb!important;outline-offset:2px}${document.css}</style></head><body>${document.html}<script>function point(t){return{x:t.clientX,y:t.clientY}}function distance(t){var a=t[0],b=t[1];return Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY)}document.addEventListener('pointerdown',function(event){var target=event.target.closest('[data-qahwa-id]');if(!target)return;event.preventDefault();document.querySelectorAll('[data-qahwa-selected]').forEach(function(node){node.removeAttribute('data-qahwa-selected')});target.setAttribute('data-qahwa-selected','');parent.postMessage({type:'qahwa-canvas-select',id:target.getAttribute('data-qahwa-id'),tag:target.tagName.toLowerCase(),text:(target.textContent||target.getAttribute('alt')||'').trim().slice(0,160)},'*')},true);document.addEventListener('touchstart',function(e){e.preventDefault();if(e.touches.length>1)parent.postMessage({type:'qahwa-gesture-start',mode:'pinch',distance:distance(e.touches)},'*');else{var p=point(e.touches[0]);parent.postMessage({type:'qahwa-gesture-start',mode:'pan',x:p.x,y:p.y},'*')}},{passive:false});document.addEventListener('touchmove',function(e){e.preventDefault();if(e.touches.length>1)parent.postMessage({type:'qahwa-gesture-move',mode:'pinch',distance:distance(e.touches)},'*');else{var p=point(e.touches[0]);parent.postMessage({type:'qahwa-gesture-move',mode:'pan',x:p.x,y:p.y},'*')}},{passive:false});document.addEventListener('touchend',function(){parent.postMessage({type:'qahwa-gesture-end'},'*')})<\/script></body></html>`;
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const value = event.data as { type?: string; id?: string; tag?: string; text?: string };
      if (event.source !== frameRef.current?.contentWindow) return;
      if (value?.type === "qahwa-canvas-select" && value.id) { const selected = `${value.id} (${value.tag ?? "element"})${value.text ? `: ${value.text}` : ""}`; setSelection(selected); onSelect(selected); return; }
      const data = event.data as { type?: string; mode?: "pan" | "pinch"; distance?: number; x?: number; y?: number };
      const stage = stageRef.current;
      if (!stage) return;
      if (data.type === "qahwa-gesture-start" && data.mode) gesture.current = { mode: data.mode, distance: data.distance || 1, x: data.x || 0, y: data.y || 0, left: stage.scrollLeft, top: stage.scrollTop, zoom };
      else if (data.type === "qahwa-gesture-move" && gesture.current?.mode === "pinch") setZoom(Math.min(1.5, Math.max(.25, gesture.current.zoom * (data.distance || gesture.current.distance) / gesture.current.distance)));
      else if (data.type === "qahwa-gesture-move" && gesture.current?.mode === "pan") { stage.scrollLeft = gesture.current.left - ((data.x || 0) - gesture.current.x); stage.scrollTop = gesture.current.top - ((data.y || 0) - gesture.current.y); }
      else if (data.type === "qahwa-gesture-end") gesture.current = null;
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onSelect, zoom]);
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); setVersionId("current"); await onChanged(); } catch (error) { onError(error instanceof Error ? error.message : "Canvas action failed"); } };
  return <section className={`design-panel${fullscreen ? " fullscreen" : ""}`}>
    <header><div><strong>{document.artboard.name}</strong><small>Revision {displayedRevision} · {document.artboard.width}×{document.artboard.height}{selection ? ` · ${selection.split(":")[0]}` : ""}</small></div><div className="canvas-version-controls">{workspace.designVersions.length > 0 && <select aria-label="Canvas version" value={versionId} onChange={(event) => { setVersionId(event.target.value); setSelection(null); onSelect(null); }}><option value="current">Current</option>{workspace.designVersions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select>}<button type="button" onClick={() => { const name = window.prompt("Version name", `Revision ${displayedRevision}`); if (name) void run(() => api.createDesignVersion(taskId, name)); }} aria-label="Save version"><Save /></button>{versionId !== "current" && <button type="button" onClick={() => { if (window.confirm("Restore this version as the current canvas?")) void run(() => api.restoreDesignVersion(taskId, versionId)); }} aria-label="Restore version"><RotateCcw /></button>}</div><div className="canvas-controls"><button type="button" onClick={() => setZoom(Math.max(.25, zoom - .1))} aria-label="Zoom out"><Minus /></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom(Math.min(1.5, zoom + .1))} aria-label="Zoom in"><Plus /></button><button type="button" onClick={() => setZoom(.75)} aria-label="Fit canvas"><Maximize2 /></button><button type="button" onClick={() => setFullscreen(!fullscreen)} aria-label={fullscreen ? "Exit full canvas" : "Open full canvas"}>{fullscreen ? <Shrink /> : <Expand />}</button></div></header>
    {workspace.session.runState === "running" && <div className="canvas-activity"><LoaderCircle />{workspace.workActivities.filter((item) => item.status === "running").at(-1)?.title ?? "Working on canvas"}</div>}
    <div className="design-stage" ref={stageRef}><iframe ref={frameRef} title={document.artboard.name} sandbox="allow-scripts" srcDoc={source} style={{ width: document.artboard.width * zoom, height: document.artboard.height * zoom }} /></div>
  </section>;
}

function WorkLog({ activities, running, waiting }: { activities: WorkActivity[]; running: boolean; waiting: boolean }) {
  const [expanded, setExpanded] = useState(running);
  useEffect(() => { if (running) setExpanded(true); }, [running]);
  const hasError = activities.some((item) => item.status === "error");
  const heading = waiting ? "Waiting for you" : running ? "Codex is working" : hasError ? "Work finished with issues" : "Work completed";
  return <section className={`work-log ${running ? "active" : hasError ? "error" : "complete"}`} aria-live="polite">
    <button className="work-log-summary" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span className="work-log-orb">{running && !waiting ? <LoaderCircle className="spin" /> : hasError ? <AlertCircle /> : <CircleCheck />}</span>
      <span><strong>{heading}</strong><small>{activities.length ? `${activities.length} ${activities.length === 1 ? "activity" : "activities"}` : "Preparing the first step"}</small></span>
      {expanded ? <ChevronUp /> : <ChevronDown />}
    </button>
    {expanded && activities.length > 0 && <div className="work-log-list">{activities.map((item) => <WorkItem key={item.id} item={item} />)}</div>}
  </section>;
}

function WorkItem({ item }: { item: WorkActivity }) {
  const [open, setOpen] = useState(item.status === "running");
  const hasDetails = Boolean(item.detail || item.context);
  useEffect(() => { if (item.status === "running") setOpen(true); }, [item.status]);
  return <div className={`work-item ${item.status}`}>
    <button type="button" className="work-item-heading" onClick={() => hasDetails && setOpen((value) => !value)} aria-expanded={hasDetails ? open : undefined}>
      <span className="work-item-icon">{workIcon(item)}</span>
      <span className="work-item-title">{item.title}</span>
      {hasDetails && (open ? <ChevronUp className="work-item-chevron" /> : <ChevronDown className="work-item-chevron" />)}
      <span className="work-item-state">{item.status === "running" ? <LoaderCircle className="spin" /> : item.status === "error" ? <AlertCircle /> : <Check />}</span>
    </button>
    {open && hasDetails && <div className="work-item-details">{item.detail && <code>{item.detail}</code>}{item.context && <pre>{item.context}</pre>}</div>}
  </div>;
}

function workIcon(item: WorkActivity) {
  if (item.kind === "thinking") return <BrainCircuit />;
  if (item.kind === "search") return <Search />;
  if (item.kind === "edit") return <FilePenLine />;
  if (item.kind === "tool") return <Code2 />;
  if (item.kind === "error") return <AlertCircle />;
  return <Terminal />;
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
