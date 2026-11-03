import { ArrowUpRight, CircleCheck, Expand, Focus, LoaderCircle, MessageSquare, MessageSquarePlus, Plus, Pencil, Shrink, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canvasCommentAnchor, canvasCommentTargets, type CanvasCommentAnchor, type CanvasCommentTarget } from "../../domain/canvas-comment";
import { documentFromPlainText, type TaskComment, type TaskWorkspace } from "../../domain/types";
import { api } from "../api";
import { canvasSource } from "../canvas-source";
import { useCanvasViewport } from "../use-canvas-viewport";

type Selection = { targets: CanvasCommentTarget[]; multiple: boolean };
export type CanvasSelectionContext = { label: string; count: number };
type Bounds = { x: number; y: number; width: number; height: number };

export function DesignCanvas({ workspace, taskId, comments, connected, activityTitle, actionsContainer, selectionResetKey = 0, onSelect, onChanged, onError }: {
  workspace: TaskWorkspace; taskId: string; comments: TaskComment[]; connected: boolean; activityTitle?: string;
  actionsContainer?: HTMLElement | null;
  selectionResetKey?: number;
  onSelect: (selection: CanvasSelectionContext | null) => void; onChanged: () => Promise<void>; onError: (message: string) => void;
}) {
  const [pageEditor, setPageEditor] = useState<"create" | "rename" | null>(null);
  const [pageName, setPageName] = useState("");
  const pageSelectRef = useRef<HTMLSelectElement>(null);
  const pageNameRef = useRef<HTMLInputElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [selection, setSelection] = useState<Selection>({ targets: [], multiple: false });
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [draftTarget, setDraftTarget] = useState<CanvasCommentAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [bounds, setBounds] = useState<Record<string, Bounds>>({});
  const [loaded, setLoaded] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commentsButtonRef = useRef<HTMLButtonElement>(null);
  const design = workspace.design!;
  const pageId = workspace.selectedDesignPageId!;
  const selectedPage = workspace.designPages.find(page => page.id === pageId)!;
  const document = design.document;
  const displayedRevision = design.revision;
  const source = useMemo(() => canvasSource(document), [document]);
  const threads = comments.filter(comment => !comment.parentId && canvasCommentAnchor(comment)?.pageId === pageId);
  const openThreads = threads.filter(comment => !comment.resolvedAt);

  const targetAt = (x: number, y: number): CanvasCommentTarget | null => {
    const element = frameRef.current?.contentDocument?.elementFromPoint(x, y)?.closest("[data-qahwa-id]");
    const elementId = element?.getAttribute("data-qahwa-id");
    if (!element || !elementId) return null;
    const text = (element.textContent || element.getAttribute("alt") || "").trim();
    return { elementId, label: `${elementId} (${element.tagName.toLowerCase()})${text ? `: ${text.slice(0, 160)}` : ""}` };
  };
  const clearSelection = useCallback(() => setSelection({ targets: [], multiple: false }), []);
  const { stageRef, artboardRef, zoom } = useCanvasViewport(document.artboard.width, document.artboard.height, fullscreen, (x, y) => {
    const target = targetAt(x, y);
    setSelection(current => {
      // Empty canvas taps preserve an active multi-selection; Clear is explicit.
      if (!target) return current.multiple ? current : { targets: [], multiple: false };
      if (!current.multiple) return { targets: [target], multiple: false };
      const targets = current.targets.some(item => item.elementId === target.elementId)
        ? current.targets.filter(item => item.elementId !== target.elementId) : [...current.targets, target];
      return { targets, multiple: targets.length > 0 };
    });
  }, (x, y) => {
    const target = targetAt(x, y);
    if (!target) return;
    setSelection(current => ({
      targets: current.targets.some(item => item.elementId === target.elementId) ? current.targets : [...current.targets, target],
      multiple: true,
    }));
  }, `${pageId}:${displayedRevision}:${selectionResetKey}`);
  useEffect(clearSelection, [source, pageId, displayedRevision, clearSelection]);
  useEffect(() => {
    clearSelection();
    frameRef.current?.contentWindow?.getSelection()?.removeAllRanges();
  }, [selectionResetKey, clearSelection]);
  useEffect(() => {
    const labels = selection.targets.map(target => target.label);
    onSelect(labels.length ? { label: labels.length > 1 ? labels.map(label => `• ${label}`).join("\n") : labels[0]!, count: labels.length } : null);
    const selectedIds = new Set(selection.targets.map(target => target.elementId));
    frameRef.current?.contentDocument?.querySelectorAll("[data-qahwa-id]").forEach(element => {
      element.toggleAttribute("data-qahwa-selected", selectedIds.has(element.getAttribute("data-qahwa-id")!));
    });
  }, [selection, loaded, onSelect]);
  useEffect(() => { setDraftTarget(null); setDraft(""); setBounds({}); setPageEditor(null); }, [pageId]);
  useEffect(() => { if (pageEditor) pageNameRef.current?.focus(); }, [pageEditor]);
  useLayoutEffect(() => {
    const frameDocument = frameRef.current?.contentDocument;
    if (!frameDocument?.body) return;
    const measure = () => {
      const next: Record<string, Bounds> = {};
      frameDocument.querySelectorAll("[data-qahwa-id]").forEach(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width && rect.height) next[element.getAttribute("data-qahwa-id")!] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      setBounds(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frameDocument.body);
    frameDocument.querySelectorAll("[data-qahwa-id]").forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [source, loaded, document.artboard.width, document.artboard.height]);
  useEffect(() => {
    if (!fullscreen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setFullscreen(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [fullscreen]);
  const closeComments = () => { setCommentsOpen(false); commentsButtonRef.current?.focus({ preventScroll: true }); };
  const run = async (operation: () => Promise<unknown>) => {
    if (!connected || busy) return false;
    setBusy(true);
    try { await operation(); await onChanged(); return true; }
    catch (error) { onError(error instanceof Error ? error.message : "Canvas action failed"); return false; }
    finally { setBusy(false); }
  };
  const focusItems = (targets: CanvasCommentTarget[], locateId?: string) => {
    const present = targets.filter(target => bounds[target.elementId]);
    if (!present.length) return;
    setSelection(current => ({ targets: present, multiple: current.multiple || targets.length > 1 }));
    const rects = present.filter(target => !locateId || target.elementId === locateId).map(target => bounds[target.elementId]!);
    const stage = stageRef.current, board = artboardRef.current;
    if (rects.length && stage && board) {
      const left = Math.min(...rects.map(rect => rect.x)), top = Math.min(...rects.map(rect => rect.y));
      const right = Math.max(...rects.map(rect => rect.x + rect.width)), bottom = Math.max(...rects.map(rect => rect.y + rect.height));
      const b = board.getBoundingClientRect(), s = stage.getBoundingClientRect();
      stage.scrollLeft += b.left - s.left + (left + right) / 2 * zoom - stage.clientWidth / 2;
      stage.scrollTop += b.top - s.top + (top + bottom) / 2 * zoom - stage.clientHeight / 2;
    }
  };
  const addComment = () => {
    if (!selection.targets.length) return;
    // Reopening an existing draft must never silently change its targets.
    if (!draftTarget) setDraftTarget({ ...selection.targets[0]!, ...(selection.targets.length > 1 ? { targets: selection.targets } : {}), revision: displayedRevision, pageId });
    setCommentsOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };
  const pins = new Map<string, TaskComment[]>();
  for (const comment of openThreads) {
    for (const target of canvasCommentTargets(canvasCommentAnchor(comment)!)) {
      pins.set(target.elementId, [...(pins.get(target.elementId) ?? []), comment]);
    }
  }
  const actions = <div className="canvas-subheader-actions" role="group" aria-label="Canvas actions">
    <button type="button" onClick={() => setFullscreen(!fullscreen)} aria-label={fullscreen ? "Exit full canvas" : "Open full canvas"} title={fullscreen ? "Exit full canvas" : "Open full canvas"}>{fullscreen ? <Shrink aria-hidden="true" /> : <Expand aria-hidden="true" />}</button>
    <button ref={commentsButtonRef} type="button" aria-label={`Canvas comments (${openThreads.length} open)`} title="Canvas comments" aria-expanded={commentsOpen} onClick={() => setCommentsOpen(!commentsOpen)}><MessageSquare aria-hidden="true" /><b aria-hidden="true">{openThreads.length}</b></button>
    <button type="button" className="canvas-add-comment" aria-label="Comment" title="Add comment on selected elements" disabled={!selection.targets.length || !connected || busy} onClick={addComment}><MessageSquarePlus aria-hidden="true" /></button>
  </div>;

  return <section className={`design-panel${fullscreen ? " fullscreen" : ""}`}>
    <header className="canvas-toolbar">
      {!fullscreen && actionsContainer ? createPortal(actions, actionsContainer) : actions}
      <div className="canvas-page-controls">
        <select ref={pageSelectRef} aria-label="Canvas page" title={selectedPage.name} value={pageId} disabled={!connected || busy} onChange={event => {
          const target = event.target.value;
          void run(() => api.selectDesignPage(taskId, target)).then(changed => {
            if (changed) window.requestAnimationFrame(() => pageSelectRef.current?.focus({ preventScroll: true }));
          });
        }}>{workspace.designPages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}</select>
        <button type="button" disabled={!connected || busy} onClick={() => { setPageName(`Page ${workspace.designPages.length + 1}`); setPageEditor("create"); }} aria-label="New page" title="New page"><Plus aria-hidden="true" /></button>
        <button type="button" disabled={!connected || busy} onClick={() => { setPageName(selectedPage.name); setPageEditor("rename"); }} aria-label="Rename page" title="Rename page"><Pencil aria-hidden="true" /></button>
      </div>
      <div className="canvas-meta"><small>{document.artboard.width}×{document.artboard.height}</small><span className="canvas-selection-tools" role="status" title={selection.targets.map(target => target.label).join("\n")}>{selection.multiple ? `Multi-select · ${selection.targets.length} selected` : selection.targets[0] ? `Selected: ${selection.targets[0].label}` : "Tap to select · Hold to select multiple"}</span>{selection.targets.length > 0 && <button type="button" className="canvas-clear-selection" aria-label="Clear canvas selection" title="Clear selection" onClick={clearSelection}><X aria-hidden="true" /></button>}</div>
      {pageEditor && <form className="canvas-page-editor" onSubmit={event => {
        event.preventDefault();
        if (!pageName.trim()) return;
        void run(async () => {
          if (pageEditor === "create") await api.createDesignPage(taskId, pageName.trim());
          else await api.renameDesignPage(taskId, pageId, pageName.trim());
          setPageEditor(null);
          pageSelectRef.current?.focus();
        });
      }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setPageEditor(null); pageSelectRef.current?.focus(); } }}>
        <label htmlFor={`canvas-page-name-${taskId}`}>{pageEditor === "create" ? "New page name" : "Page name"}</label>
        <input ref={pageNameRef} id={`canvas-page-name-${taskId}`} value={pageName} maxLength={80} required disabled={busy} onChange={event => setPageName(event.target.value)} />
        <button type="submit" disabled={!connected || busy || !pageName.trim()}>{pageEditor === "create" ? "Create page" : "Rename"}</button>
        <button type="button" disabled={busy} onClick={() => { setPageEditor(null); pageSelectRef.current?.focus(); }}>Cancel</button>
      </form>}
    </header>
    {workspace.session.runState === "running" && <div className="canvas-activity"><LoaderCircle />{activityTitle ?? "Working on canvas"}</div>}
    <div className="canvas-body">
      <div className="design-stage" ref={stageRef} role="region" aria-label="Design canvas" tabIndex={0} title="Drag to pan. Pinch or Ctrl/⌘ + scroll to zoom. Arrow keys to pan; +/− to zoom; 0 to fit.">
        <div className="canvas-world" style={{ width: document.artboard.width * zoom + 48, height: document.artboard.height * zoom + 48 }}>
          <div className="canvas-artboard" ref={artboardRef} style={{ width: document.artboard.width * zoom, height: document.artboard.height * zoom }}>
            <iframe key={pageId} ref={frameRef} title={document.artboard.name} tabIndex={-1} sandbox="allow-same-origin" srcDoc={source} onLoad={() => setLoaded(value => value + 1)} style={{ width: document.artboard.width, height: document.artboard.height, transform: `scale(${zoom})` }} />
            {[...pins].map(([id, items]) => bounds[id] && <button key={id} type="button" className="canvas-comment-pin" aria-label={`${items.length} open canvas comment${items.length === 1 ? "" : "s"} on ${id}`} style={{ left: Math.max(0, Math.min(document.artboard.width * zoom - 32, (bounds[id].x + bounds[id].width) * zoom - 16)), top: Math.max(0, Math.min(document.artboard.height * zoom - 32, bounds[id].y * zoom)) }} onClick={() => { focusItems(canvasCommentTargets(canvasCommentAnchor(items[0]!)!), id); setCommentsOpen(true); }}><MessageSquare /><b>{items.length}</b></button>)}
          </div>
        </div>
      </div>
      {commentsOpen && <section className="canvas-comments" aria-label="Canvas comments" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeComments(); } }}>
        <header><div><strong>Canvas comments</strong><small>{openThreads.length} comment{openThreads.length === 1 ? "" : "s"} on this page</small></div>
          <button type="button" aria-label="Close canvas comments" title="Close canvas comments" onClick={closeComments}><X aria-hidden="true" /></button>
        </header>
        <div className="canvas-comments-scroll">
          {draftTarget && <form onSubmit={event => {
            event.preventDefault();
            if (!draft.trim()) return;
            void run(async () => {
              await api.addCanvasComment(taskId, documentFromPlainText(draft.trim()), draftTarget);
              setDraft(""); setDraftTarget(null);
            });
          }}><label htmlFor={`canvas-comment-${taskId}`}>Comment on {canvasCommentTargets(draftTarget).length > 1 ? `${canvasCommentTargets(draftTarget).length} elements` : draftTarget.elementId}</label><div className="canvas-comment-targets">{canvasCommentTargets(draftTarget).map(target => <span key={target.elementId} title={target.label}>{target.elementId}{!bounds[target.elementId] && " (missing)"}</span>)}</div><small>Revision {draftTarget.revision}</small><textarea id={`canvas-comment-${taskId}`} ref={inputRef} value={draft} maxLength={10000} onChange={event => setDraft(event.target.value)} disabled={busy} rows={3} /><button type="submit" disabled={!connected || busy || !draft.trim()}>Add comment</button><button type="button" disabled={busy} onClick={() => { setDraft(""); setDraftTarget(null); }}>Cancel draft</button></form>}
          {openThreads.map(comment => {
            const anchor = canvasCommentAnchor(comment)!;
            const targets = canvasCommentTargets(anchor);
            const targetName = targets.length > 1 ? `${targets.length} elements` : anchor.elementId;
            return <article className={`canvas-comment-thread${targets.some(target => selection.targets.some(selected => selected.elementId === target.elementId)) ? " is-selected" : ""}`} key={comment.id} data-comment-id={comment.id}>
              <div className="canvas-comment-heading">
                <button type="button" className="canvas-comment-element" disabled={!targets.some(target => bounds[target.elementId])} title={`Find ${targetName}`} onClick={() => focusItems(targets)}><Focus aria-hidden="true" /><span>{targetName}</span><ArrowUpRight aria-hidden="true" /></button>
                <button type="button" className="canvas-comment-resolve" aria-label={`Resolve comment on ${targetName}`} title="Resolve comment" disabled={!connected || busy} onClick={() => void run(() => api.resolveCanvasComment(comment.id, true))}><CircleCheck aria-hidden="true" /></button>
              </div>
              {targets.length > 1 ? <div className="canvas-comment-targets">{targets.map(target => <button type="button" key={target.elementId} disabled={!bounds[target.elementId]} title={target.label} onClick={() => focusItems(targets, target.elementId)}>{target.elementId}{!bounds[target.elementId] && " (missing)"}</button>)}</div> : !bounds[anchor.elementId] && <small>Item is absent from this page.</small>}
              <p>{comment.plainText}</p>
              {comment.replies.map(reply => <p className="canvas-comment-reply" key={reply.id}><strong>{reply.author}: </strong>{reply.plainText}</p>)}
            </article>;
          })}
        </div>
      </section>}
    </div>
  </section>;
}
