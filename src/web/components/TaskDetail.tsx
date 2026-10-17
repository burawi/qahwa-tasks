import { ArrowLeft, Check, ChevronDown, ChevronRight, History, MessageCircle, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { documentFromPlainText, emptyDocument, type RichTextDocument, type TaskComment, type TaskDetail as TaskDetailType, type TaskStatus } from "../../domain/types";
import { api } from "../api";
import { projectColorStyle } from "../project-color";
import { RichEditor, RichView } from "./RichEditor";

interface Props {
  taskId: string;
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

export function TaskDetail({ taskId, onClose, onChanged, onError }: Props) {
  const [task, setTask] = useState<TaskDetailType | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState<RichTextDocument>(emptyDocument());
  const [comment, setComment] = useState<RichTextDocument>(emptyDocument());
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [activity, setActivity] = useState<Array<{ actor: string; eventType: string; createdAt: string }>>([]);

  const load = async () => {
    try {
      const result = await api.task(taskId);
      setTask(result.task);
      setTitle(result.task.title);
      setDescription(result.task.description);
    } catch (error) { onError(error instanceof Error ? error.message : "Could not load task"); }
  };
  useEffect(() => { void load(); }, [taskId]);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); await load(); onChanged(); }
    catch (error) { onError(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(false); }
  };

  if (!task) return <div className="detail-page"><div className="detail-loading">Loading task…</div></div>;
  const actions = statusActions(task.status);
  const unresolved = task.comments.filter((item) => !item.resolvedAt);
  const resolved = task.comments.filter((item) => item.resolvedAt);

  const save = () => run(async () => {
    await api.updateTask(task.id, { title, description, expectedVersion: task.version });
    setEditing(false);
  });
  const addComment = () => run(async () => {
    await api.addComment(task.id, comment);
    setComment(emptyDocument());
  });
  const transition = (to: TaskStatus, outcome?: "completed" | "cancelled") => run(() => api.transition(task.id, to, outcome));
  const remove = () => {
    if (!window.confirm(`Permanently delete ${task.humanId}?`)) return;
    void run(async () => { await api.deleteTask(task.id); onClose(); });
  };

  return <div className="detail-page">
    <header className="detail-header project-accent" style={projectColorStyle(task.projectId)}>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Back"><ArrowLeft /></button>
      <div><span>{task.humanId}</span><small className="project-label"><span className="project-dot" />{task.projectName}</small></div>
      {!editing && <button type="button" className="icon-button" onClick={() => setEditing(true)} aria-label="Edit"><Pencil /></button>}
    </header>

    <main className="detail-content">
      {editing ? <section className="edit-panel">
        <label>Title<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Description<RichEditor value={description} onChange={setDescription} placeholder="Describe the task…" /></label>
        <div className="button-row"><button type="button" className="secondary" onClick={() => { setEditing(false); setTitle(task.title); setDescription(task.description); }}><X />Cancel</button><button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void save()}><Check />Save</button></div>
      </section> : <section className="task-copy">
        <h1>{task.title}</h1>
        <RichView document={task.description} />
      </section>}

      <section className="status-panel">
        <div><span className={`status-pill ${task.status}`}>{statusLabel(task.status)}</span>{task.outcome && <span className={`outcome ${task.outcome}`}>{task.outcome}</span>}</div>
        <div className="status-actions">
          {actions.map((action) => <button key={action.label} type="button" disabled={busy} className={action.kind ?? "secondary"} onClick={() => transition(action.to, action.outcome)}>{action.label}</button>)}
          {task.status !== "backlog" && task.status !== "closed" && <button type="button" disabled={busy} className="danger-subtle" onClick={() => transition("closed", "cancelled")}>Cancel task</button>}
          {task.status === "backlog" && <button type="button" disabled={busy} className="danger-subtle" onClick={remove}><Trash2 />Delete</button>}
        </div>
      </section>

      <section className="comments-section">
        <h2><MessageCircle />Comments <span>{unresolved.length}</span></h2>
        {unresolved.length === 0 && <p className="empty-note">No open comment threads.</p>}
        {unresolved.map((thread) => <CommentThread key={thread.id} thread={thread} taskId={task.id} onChanged={load} onError={onError} />)}
        <div className="new-comment"><RichEditor compact value={comment} onChange={setComment} placeholder="Leave feedback…" /><button type="button" className="primary" disabled={busy || !documentHasText(comment)} onClick={() => void addComment()}>Comment</button></div>
        {resolved.length > 0 && <details className="resolved-comments"><summary>{resolved.length} resolved thread{resolved.length === 1 ? "" : "s"}</summary>{resolved.map((thread) => <CommentThread key={thread.id} thread={thread} taskId={task.id} onChanged={load} onError={onError} />)}</details>}
      </section>

      <section className="history-section">
        <button type="button" className="history-toggle" onClick={async () => {
          if (!showHistory) setActivity((await api.activity(task.id)).activity);
          setShowHistory(!showHistory);
        }}>{showHistory ? <ChevronDown /> : <ChevronRight />}<History />Activity</button>
        {showHistory && <ol>{activity.map((item, index) => <li key={`${item.createdAt}-${index}`}><span>{activityLabel(item.eventType)}</span><small>{item.actor} · {formatDate(item.createdAt)}</small></li>)}</ol>}
      </section>
    </main>
  </div>;
}

function CommentThread({ thread, taskId, onChanged, onError }: { thread: TaskComment; taskId: string; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState<RichTextDocument>(emptyDocument());
  const act = async (operation: () => Promise<unknown>) => {
    try { await operation(); setReplying(false); setReply(emptyDocument()); await onChanged(); }
    catch (error) { onError(error instanceof Error ? error.message : "Comment action failed"); }
  };
  return <article className={`comment-thread${thread.resolvedAt ? " resolved" : ""}`}>
    <CommentBubble comment={thread} />
    {thread.replies.map((item) => <CommentBubble key={item.id} comment={item} reply />)}
    <div className="comment-actions">
      <button type="button" onClick={() => setReplying(!replying)}>Reply</button>
      <button type="button" onClick={() => void act(() => api.resolveComment(thread.id, !thread.resolvedAt))}>{thread.resolvedAt ? <><RotateCcw />Reopen</> : <><Check />Resolve</>}</button>
    </div>
    {replying && <div className="reply-editor"><RichEditor compact value={reply} onChange={setReply} placeholder="Write a reply…" /><div className="button-row"><button type="button" className="secondary" onClick={() => setReplying(false)}>Cancel</button><button type="button" className="primary" disabled={!documentHasText(reply)} onClick={() => void act(() => api.addComment(taskId, reply, thread.id))}>Reply</button></div></div>}
  </article>;
}

function CommentBubble({ comment, reply = false }: { comment: TaskComment; reply?: boolean }) {
  const handoff = comment.kind === "handoff";
  return <div className={`comment-bubble ${comment.author}${reply ? " reply" : ""}${handoff ? " handoff" : ""}`}>
    <div><strong>{handoff ? "Codex handoff" : comment.author === "user" ? "You" : "Codex"}</strong><time>{formatDate(comment.createdAt)}</time></div>
    <RichView document={comment.body} />
    {handoff && Boolean(comment.metadata?.sessionId) && <code>Session {String(comment.metadata?.sessionId)}</code>}
  </div>;
}

function statusActions(status: TaskStatus): Array<{ label: string; to: TaskStatus; outcome?: "completed"; kind?: string }> {
  if (status === "backlog") return [{ label: "Move to Todo", to: "todo", kind: "primary" }];
  if (status === "todo") return [{ label: "Start work", to: "in_progress", kind: "primary" }];
  if (status === "in_progress") return [{ label: "Submit for review", to: "in_review", kind: "primary" }];
  if (status === "in_review") return [
    { label: "Request changes", to: "in_progress" },
    { label: "Mark completed", to: "closed", outcome: "completed", kind: "primary" },
  ];
  return [];
}

function statusLabel(status: TaskStatus): string {
  return ({ backlog: "Backlog", todo: "Todo", in_progress: "In progress", in_review: "In review", closed: "Closed" })[status];
}

function activityLabel(value: string): string {
  return value.split(".").map((part) => part.replace(/_/g, " ")).join(" · ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function documentHasText(document: RichTextDocument): boolean {
  return JSON.stringify(document).includes('"text"');
}
