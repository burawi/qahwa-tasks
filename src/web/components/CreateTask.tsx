import { AttachmentMenu } from "./AttachmentMenu";
import { ArrowRight, File as FileIcon, Lightbulb, RotateCw, Terminal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { documentFromPlainText, type ChatAttachment, type Project, type RichTextDocument } from "../../domain/types";
import { api, ApiError } from "../api";
import { ProjectLogo } from "./ProjectLogo";

interface DraftFile {
  id: string;
  file: File;
  preview: string | null;
  attachment: ChatAttachment | null;
  progress: number;
  error: string | null;
  controller: AbortController;
}

export interface CreateTaskValue {
  projectId: string;
  description: RichTextDocument;
  status: "backlog" | "todo";
  draftId: string;
  attachmentIds: string[];
}

export function CreateTask({ projects, connected = true, initialProjectId, onCancel, onProjectChange, onSave, onTerminal }: {
  projects: Project[];
  connected?: boolean;
  initialProjectId?: string;
  onCancel: () => void;
  onProjectChange: (projectId: string) => void;
  onSave: (value: CreateTaskValue) => Promise<void>;
  onTerminal?: (projectId: string, creationKey: string) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const selectedProject = projects.find(project => project.id === projectId);
  const [note, setNote] = useState("");
  const [draftId] = useState(() => crypto.randomUUID());
  const [files, setFiles] = useState<DraftFile[]>([]);
  const filesRef = useRef<DraftFile[]>([]);
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement as HTMLElement | null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [terminalKey] = useState(() => crypto.randomUUID());
  const terminalUnconfirmed = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [dragging, setDragging] = useState(false);
  const busy = useRef(false);
  const saved = useRef(false);
  const saveUnconfirmed = useRef(false);
  const mounted = useRef(true);
  const frozen = saving || cancelling || uncertain || cancelPending || openingTerminal;
  const updateFiles = (next: DraftFile[]) => { filesRef.current = next; if (mounted.current) setFiles(next); };
  const patchFile = (id: string, patch: Partial<DraftFile>) => updateFiles(filesRef.current.map(item => item.id === id ? { ...item, ...patch } : item));

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const resize = () => {
      // The keyboard can shrink/pan only the visual viewport. Leave pinch zoom
      // to the browser rather than resizing the sheet while the user zooms.
      if (viewport && viewport.scale !== 1) return;
      backdropRef.current?.style.setProperty("--creation-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      backdropRef.current?.style.setProperty("--creation-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const form = formRef.current;
        const active = document.activeElement;
        if (!form || !(active instanceof HTMLElement) || !form.contains(active)) return;
        // Keep the focused field reachable on very short screens without
        // moving focus, remounting the draft, or scrolling the underlying page.
        const bounds = form.getBoundingClientRect();
        const field = active.getBoundingClientRect();
        const top = bounds.top + form.clientTop;
        const bottom = top + form.clientHeight;
        if (field.top < top || field.height > form.clientHeight) form.scrollTop += field.top - top;
        else if (field.bottom > bottom) form.scrollTop += field.bottom - bottom;
      });
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode replays effects in development. Defer disposal until we know
      // this is a real unmount, otherwise the active draft would be cancelled.
      queueMicrotask(() => {
        if (mounted.current) return;
        if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
        for (const item of filesRef.current) {
          item.controller.abort();
          if (item.preview) URL.revokeObjectURL(item.preview);
        }
        // A pending save may already have committed. Keep its retry key valid.
        if (!saved.current && !busy.current && !saveUnconfirmed.current) void api.cancelTaskDraft(draftId).catch(() => undefined);
      });
    };
  }, [draftId]);

  const upload = async (item: DraftFile) => {
    try {
      const attachment = await api.uploadAttachment("draft", draftId, item.file, progress => {
        if (!item.controller.signal.aborted) patchFile(item.id, { progress });
      }, item.controller.signal);
      if (item.controller.signal.aborted || !mounted.current || !filesRef.current.some(file => file.id === item.id)) {
        void api.removeAttachment(attachment.id).catch(() => undefined);
        return;
      }
      patchFile(item.id, { attachment, progress: 100 });
    } catch (failure) {
      if (mounted.current && filesRef.current.some(file => file.id === item.id)) {
        patchFile(item.id, { error: failure instanceof Error ? failure.message : "Upload failed. Retry this file." });
      }
    }
  };

  const addFiles = (additions: File[]) => {
    if (!connected || frozen || busy.current || additions.length === 0) return;
    const combined = [...filesRef.current.map(item => item.file), ...additions];
    if (additions.some(file => file.size > 100 * 1024 * 1024)) { setError("Each file may be at most 100 MiB."); return; }
    if (combined.reduce((size, file) => size + file.size, 0) > 250 * 1024 * 1024) { setError("Files may total at most 250 MiB per task."); return; }
    setError(null);
    const entries = additions.map((file): DraftFile => ({ id: crypto.randomUUID(), file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      attachment: null, progress: 0, error: null, controller: new AbortController() }));
    updateFiles([...filesRef.current, ...entries]);
    for (const item of entries) void upload(item);
  };
  const remove = (item: DraftFile) => {
    if (frozen || busy.current) return;
    item.controller.abort();
    updateFiles(filesRef.current.filter(file => file.id !== item.id));
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.attachment) void api.removeAttachment(item.attachment.id).catch(() => {
      // The draft cancellation/save also sweeps unselected uploads.
      if (mounted.current) setError("File removed from this task. Server cleanup will retry when you save or cancel.");
    });
  };
  const retry = (item: DraftFile) => {
    if (!connected || frozen || busy.current) return;
    const next = { ...item, attachment: null, error: null, progress: 0, controller: new AbortController() };
    patchFile(item.id, next);
    void upload(next);
  };
  const cancel = async () => {
    if (busy.current || uncertain) return;
    busy.current = true;
    setCancelling(true);
    setCancelPending(true);
    for (const item of filesRef.current) item.controller.abort();
    try {
      await api.cancelTaskDraft(draftId);
      saved.current = true; // Already cleaned; avoid a second unmount request.
      onCancel();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not cancel. Reconnect and retry cancellation.");
    } finally { busy.current = false; if (mounted.current) setCancelling(false); }
  };
  const openTerminal = async () => {
    if (!onTerminal || !connected || busy.current || frozen || !projectId) return;
    busy.current = true;
    setOpeningTerminal(true);
    setError(null);
    terminalUnconfirmed.current = true;
    try {
      // Only the selected project is transferred. Draft uploads are discarded
      // by the existing unmount cleanup after navigation succeeds.
      await onTerminal(projectId, terminalKey);
      terminalUnconfirmed.current = false;
      for (const item of filesRef.current) item.controller.abort();
      void api.cancelTaskDraft(draftId).catch(() => undefined);
    } catch (failure) {
      terminalUnconfirmed.current = !(failure instanceof ApiError) || failure.status >= 500;
      setError(terminalUnconfirmed.current ? "Terminal opening not confirmed. Retry to reopen the same terminal safely." : failure instanceof Error ? failure.message : "Could not open terminal");
    } finally { busy.current = false; if (mounted.current) setOpeningTerminal(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!connected || busy.current || cancelPending || terminalUnconfirmed.current || !note.trim() || !projectId || filesRef.current.some(item => !item.attachment || item.error)) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    saveUnconfirmed.current = true;
    try {
      await onSave({ projectId, description: documentFromPlainText(note.trim()), status: "backlog", draftId,
        attachmentIds: filesRef.current.map(item => item.attachment!.id) });
      saved.current = true;
      saveUnconfirmed.current = false;
    } catch (failure) {
      const ambiguous = !(failure instanceof ApiError) || failure.status >= 500;
      saveUnconfirmed.current = ambiguous;
      setUncertain(ambiguous);
      setError(ambiguous ? "Save not confirmed. Your note and files are preserved. Retry creation to recover the saved task safely." : failure.message);
    } finally { busy.current = false; if (mounted.current) setSaving(false); }
  };

  return <div ref={backdropRef} className="modal-backdrop task-create-backdrop"><form ref={formRef} className={`form-modal task-form${dragging ? " dragging" : ""}`} role="dialog" aria-modal="true" aria-labelledby="create-task-title" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); void cancel(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea, [tabindex="0"]'));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }} onSubmit={event => void submit(event)} onDragOver={event => { event.preventDefault(); if (!frozen && connected) setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
    <div className="form-heading" data-qahwa-id="creation-heading"><div><span className="modal-kicker">Quick capture</span><h2 id="create-task-title" data-qahwa-id="creation-title">What should happen?</h2></div><button type="button" className="icon-button" disabled={saving || cancelling || uncertain} onClick={() => void cancel()} aria-label="Close"><X /></button></div>
    <div className="task-create-field" data-qahwa-id="creation-project-field">
      <label htmlFor="create-task-project" data-qahwa-id="creation-project-label">Project</label>
      <div className="task-create-project-row" data-qahwa-id="creation-project-row">
        {selectedProject && <span className="task-create-project-logo" data-qahwa-id="creation-project-logo"><ProjectLogo logo={selectedProject.logo} prefix={selectedProject.prefix} size="large" /></span>}
        <select id="create-task-project" data-qahwa-id="creation-project" required disabled={frozen || terminalUnconfirmed.current} value={projectId} onChange={event => { setProjectId(event.target.value); onProjectChange(event.target.value); }}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      </div>
    </div>
    <div className="task-create-field" data-qahwa-id="creation-note-field">
      <label htmlFor="create-task-note" data-qahwa-id="creation-note-label">Task note</label>
      <div className="task-create-note-editor" data-qahwa-id="creation-note-editor">
        <textarea id="create-task-note" data-qahwa-id="creation-note" autoFocus required readOnly={frozen} maxLength={30_000} rows={4} value={note} onChange={event => setNote(event.target.value)} placeholder="e.g. The order screen feels confusing on mobile. Review it and propose a simpler flow." />
        <div className="task-create-note-toolbar" data-qahwa-id="creation-note-toolbar"><AttachmentMenu qahwaId="creation-add-files" disabled={!connected || frozen} onFiles={addFiles} /></div>
      </div>
    </div>
    <section className="task-creation-files" aria-label="Task attachments">
      <div className="task-files-heading"><small data-qahwa-id="creation-file-limits">{files.length}/10 · 100 MiB each · 250 MiB total</small></div>
      {files.length > 0 && <div className="composer-attachments" role="region" aria-label="Files for this task" tabIndex={0}>{files.map(item => <div className={`attachment-chip${item.preview ? " image" : ""}${item.error ? " error" : ""}`} key={item.id}>
        {item.preview ? <img src={item.preview} alt={`Preview of ${item.file.name}`} /> : <FileIcon aria-hidden="true" />}
        <span><strong title={item.file.name}>{item.file.name}</strong><small role={item.error ? "alert" : "status"} title={item.error ?? undefined}>{item.error ?? (item.attachment ? formatSize(item.file.size) : `Uploading ${item.progress}%`)}</small></span>
        <button type="button" disabled={frozen} onClick={() => remove(item)} aria-label={`Remove ${item.file.name}`}><X /></button>
        {item.error && <button type="button" className="attachment-retry" disabled={!connected || frozen} onClick={() => retry(item)} aria-label={`Retry ${item.file.name}`}><RotateCw /></button>}
        {!item.attachment && !item.error && <progress value={item.progress} max={100} aria-label={`Uploading ${item.file.name}`} />}
      </div>)}</div>}
    </section>
    {error && <p className="task-create-error" role="alert">{error}</p>}
    {!connected && <p role="status">Offline. Your note and selected files stay here while you reconnect.</p>}
    <div className="capture-note"><Lightbulb /><span>A concise title is generated after saving. Creating this task will not start it.</span></div>
    <div className="button-row">{onTerminal && <button type="button" className="icon-button" data-qahwa-id="creation-terminal" aria-label={openingTerminal ? "Opening terminal" : "Open terminal chat"} title="Open terminal chat" disabled={!connected || frozen || !projectId} onClick={() => void openTerminal()}><Terminal aria-hidden="true" /></button>}<button type="button" className="secondary" disabled={saving || cancelling || uncertain || openingTerminal} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : cancelPending ? "Retry cancel" : "Cancel"}</button><button type="submit" className="primary" disabled={!connected || saving || cancelling || cancelPending || openingTerminal || terminalUnconfirmed.current || !note.trim() || !projectId || files.some(item => !item.attachment || item.error)}>{saving ? "Creating…" : uncertain ? "Retry creation" : "Create task"} <ArrowRight /></button></div>
  </form></div>;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 ** 2).toFixed(1)} MiB`;
}
