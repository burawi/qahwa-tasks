import { ArrowLeft, Check, ChevronDown, ChevronRight, Download, ExternalLink, FileOutput, GitCommitHorizontal, History, MessageCircle, Pencil, Play, RotateCcw, Trash2, X } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { documentFromPlainText, emptyDocument, type RelatedTask, type RichTextDocument, type TaskArtifact, type TaskComment, type TaskDetail as TaskDetailType, type TaskStatus } from "../../domain/types";
import { api, fetchEncryptedAsset } from "../api";
import { projectColorStyle } from "../project-color";
import { RichEditor, RichView } from "./RichEditor";
import { ProjectLogo } from "./ProjectLogo";

interface Props {
  taskId: string;
  onClose: () => void;
  onChanged: () => void;
  onNavigate: (humanId: string) => void;
  onError: (message: string) => void;
}

export function TaskDetail({ taskId, onClose, onNavigate, onChanged, onError }: Props) {
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
  const discussions = task.comments.filter((item) => item.kind === "comment");
  const unresolved = discussions.filter((item) => !item.resolvedAt);
  const resolved = discussions.filter((item) => item.resolvedAt);

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
      <div><span>{task.humanId}</span><small className="project-label"><ProjectLogo logo={task.projectLogo} prefix={task.projectPrefix} size="small" />{task.projectName}</small></div>
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

      <section className="output-section">
        <h2><FileOutput />Output <span>{task.outputs.length}</span></h2>
        {task.outputs.length === 0 && <p className="empty-note">No work output has been submitted yet.</p>}
        {task.outputs.map((output) => <article className="output-card" key={output.id}>
          <header><strong>{output.summary}</strong><time>{formatDate(output.createdAt)}</time></header>
          {output.commitApproval && <CommitApprovalOutput
            approval={output.commitApproval}
            eligible={task.status === "in_review"}
            busy={busy}
            onApprove={() => run(() => api.approveCommit(task.id, output.id))}
          />}
          {output.validation.length > 0 && <OutputList label="Validation" items={output.validation} />}
          {output.commit && <p><b>Commit</b><code>{output.commit}</code></p>}
          {output.limitations.length > 0 && <OutputList label="Limitations" items={output.limitations} />}
          {output.artifacts.length > 0 && <div><b>Artifacts</b><div className="artifact-list">{output.artifacts.map((artifact, index) => <ArtifactPreview artifact={artifact} key={`${artifact.source}-${index}`} />)}</div></div>}
          {(output.sessionId || output.runId) && <footer>{output.sessionId && <code>Session {output.sessionId}</code>}{output.runId && <code>Run {output.runId}</code>}</footer>}
        </article>)}
      </section>

      <RelatedTaskList tasks={task.relatedTasks} onNavigate={onNavigate} />

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

export function RelatedTaskList({ tasks, onNavigate }: { tasks: RelatedTask[]; onNavigate: (humanId: string) => void }) {
  if (tasks.length === 0) return null;
  return <section className="related-section">
    <h2>Related tasks <span>{tasks.length}</span></h2>
    <div className="related-task-list">{tasks.map((related) => <a
      className="related-task-card" href={`/tasks/${encodeURIComponent(related.humanId)}`} key={related.id}
      onClick={(event) => { event.preventDefault(); onNavigate(related.humanId); }}
    >
      <span><strong>{related.humanId}</strong><small>{related.projectName}</small></span>
      <b>{related.title}</b>
      <span className={`status-pill ${related.status}`}>{statusLabel(related.status)}</span>
    </a>)}</div>
  </section>;
}

function OutputList({ label, items }: { label: string; items: string[] }) {
  return <div><b>{label}</b><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

export function CommitApprovalOutput({ approval, eligible, busy = false, onApprove = () => undefined }: {
  approval: NonNullable<TaskDetailType["outputs"][number]["commitApproval"]>;
  eligible: boolean;
  busy?: boolean;
  onApprove?: () => void;
}) {
  const committed = approval.status === "committed";
  return <section className={`commit-approval ${approval.status}`}>
    <div className="commit-approval-heading">
      <div><GitCommitHorizontal /><b>{committed ? "Approved commit" : "Commit approval"}</b></div>
      {!committed && <button type="button" className="primary" disabled={busy || !eligible} onClick={onApprove}>Approve commit</button>}
    </div>
    <p>{approval.releaseNote}</p>
    <dl>
      <div><dt>Message</dt><dd><code>{approval.message}</code></dd></div>
      <div><dt>Repository</dt><dd><code>{approval.repositoryRoot}</code></dd></div>
      <div><dt>Base revision</dt><dd><code>{approval.baseRevision}</code></dd></div>
      <div><dt>Reviewed files</dt><dd><ul>{approval.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></dd></div>
      {approval.commitHash && <div><dt>Commit</dt><dd><code>{approval.commitHash}</code></dd></div>}
    </dl>
    {!committed && !eligible && <small>Commit approval is available while this task is in review.</small>}
    <small>This action commits only the reviewed files. It does not start Codex, push, publish, or deploy.</small>
  </section>;
}

export function ArtifactPreview({ artifact }: { artifact: TaskArtifact }) {
  const [requested, setRequested] = useState(artifact.previewKind === "image" && artifact.sourceType === "path");
  const [secureHref, setSecureHref] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const directHref = artifact.sourceType === "url" ? artifact.previewUrl : null;
  useEffect(() => {
    if (artifact.sourceType !== "path" || !artifact.previewUrl || artifact.availability !== "available") return;
    let active = true;
    let objectUrl: string | null = null;
    void fetchEncryptedAsset(artifact.previewUrl).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setSecureHref(objectUrl);
    }).catch((error) => active && setAssetError(error instanceof Error ? error.message : "Asset unavailable"));
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.previewUrl, artifact.sourceType, artifact.availability]);
  const href = directHref ?? secureHref;
  const canPreview = Boolean(artifact.previewUrl && artifact.previewKind !== "none");
  return <article className={`artifact-card ${artifact.availability}`}>
    {canPreview && requested && href && <ArtifactMedia artifact={artifact} source={href} />}
    <div className="artifact-info">
      <strong>{artifact.filename}</strong>
      <small>{[artifact.mediaType ?? "Unknown type", formatBytes(artifact.size)].filter(Boolean).join(" · ")}</small>
      <code>{artifact.source}</code>
      {assetError && <span className="artifact-placeholder">{assetError}</span>}
      {!canPreview && <span className="artifact-placeholder">{artifactMessage(artifact)}</span>}
    </div>
    <div className="artifact-actions">
      {canPreview && !requested && <button type="button" onClick={() => setRequested(true)}><Play />Preview</button>}
      {href && <a href={href} target="_blank" rel="noreferrer"><ExternalLink />Open</a>}
      {href && <a href={href} download={artifact.sourceType === "url" ? undefined : artifact.filename}><Download />Download</a>}
    </div>
  </article>;
}

function ArtifactMedia({ artifact, source }: { artifact: TaskArtifact; source: string }) {
  if (artifact.previewKind === "image") {
    return <img className="artifact-preview" src={source} alt={artifact.filename} loading="lazy" decoding="async" />;
  }
  if (artifact.previewKind === "video") {
    return <video className="artifact-preview" src={source} controls preload="metadata"><track kind="captions" /></video>;
  }
  if (artifact.previewKind === "pdf") {
    return <iframe className="artifact-preview pdf" src={source} title={`Preview ${artifact.filename}`} loading="lazy" />;
  }
  return null;
}

function artifactMessage(artifact: TaskArtifact): string {
  return ({
    missing: "File is no longer available.",
    unsupported: "Preview is not supported for this file.",
    too_large: "File is too large to preview safely.",
    outside_scope: "File is outside the authorized project folder.",
    available: "Preview unavailable.",
    external: "Preview unavailable.",
  })[artifact.availability];
}

function formatBytes(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; size >= 1024 && index < units.length; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
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

export function statusActions(status: TaskStatus): Array<{ label: string; to: TaskStatus; outcome?: "completed"; kind?: string }> {
  if (status === "backlog") return [{ label: "Move to Todo", to: "todo", kind: "primary" }];
  if (status === "todo") return [{ label: "Start work", to: "in_progress", kind: "primary" }];
  if (status === "in_progress") return [{ label: "Submit for review", to: "in_review", kind: "primary" }];
  if (status === "in_review") return [{ label: "Mark completed", to: "closed", outcome: "completed", kind: "primary" }];
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
