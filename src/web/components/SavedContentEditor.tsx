import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { ApiError } from "../api";

export interface SavedContent {
  version: number;
  text: string;
  title?: string;
  canEdit?: boolean;
}

/** Holds its own snapshot: polling must never replace a user's in-progress draft. */
export function SavedContentEditor({ kind, initial, connected, onSave, onLatest, onClose }: {
  kind: "task" | "message";
  initial: SavedContent;
  connected: boolean;
  onSave: (draft: SavedContent) => Promise<void>;
  onLatest: () => Promise<SavedContent>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const savingRef = useRef(false);
  const [text, setText] = useState(initial.text);
  const [title, setTitle] = useState(initial.title);
  const [version, setVersion] = useState(initial.version);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<SavedContent | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus({ preventScroll: true });
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!connected || savingRef.current || loading || conflict) return;
    savingRef.current = true;
    setSaving(true); setError("");
    try {
      await onSave({ text, title, version });
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save.";
      setError(message.includes("Your draft is kept") ? message : `${message} Your draft is kept.`);
      setConflict(error instanceof ApiError && error.code === "version_conflict");
    } finally { savingRef.current = false; setSaving(false); }
  };
  const reviewLatest = async () => {
    setLoading(true);
    try { setLatest(await onLatest()); }
    catch (error) { setError(`${error instanceof Error ? error.message : "Could not load the latest content."} Your draft is kept.`); }
    finally { setLoading(false); }
  };
  return <dialog ref={dialog} className="saved-content-dialog" aria-labelledby="saved-content-heading"
    onCancel={event => { event.preventDefault(); if (!savingRef.current) onClose(); }}>
    <form className="saved-content-form" onSubmit={save}>
      <div className="form-heading"><div><h2 id="saved-content-heading">Edit {kind === "task" ? "task" : "pending message"}</h2>
        <p>{kind === "task" ? "Update the title and description before this task starts." : "Attached files and selected context stay with this message."}</p></div>
        <button type="button" className="icon-button" disabled={saving} aria-label="Close editor" onClick={onClose}><X /></button>
      </div>
      {title !== undefined && <label>Title<input value={title} maxLength={200} required readOnly={saving} onChange={event => setTitle(event.target.value)} /></label>}
      <label>{kind === "task" ? "Description" : "Message text"}<textarea value={text} maxLength={kind === "message" ? 30_000 : 90_000} rows={6} readOnly={saving} onChange={event => setText(event.target.value)} /></label>
      {error && <p className="saved-content-error" role="alert">{error}</p>}
      {conflict && <button type="button" className="secondary" disabled={!connected || loading || saving} onClick={() => void reviewLatest()}>{loading ? "Loading…" : "Review latest saved content"}</button>}
      {latest && <div className="saved-content-latest"><strong>Latest saved content</strong>{latest.title !== undefined && <p>{latest.title}</p>}<pre>{latest.text || "(No text)"}</pre>
        {latest.canEdit ? <button type="button" className="secondary" disabled={saving} onClick={() => { setVersion(latest.version); setConflict(false); setLatest(null); setError("Your draft is kept. Save to apply it to the version you reviewed."); }}>Keep draft and use this version</button>
          : <p>This {kind} can no longer be edited. Your draft is kept above.</p>}
      </div>}
      <div className="button-row"><button type="button" className="secondary" disabled={saving} onClick={onClose}>Discard changes</button><button className="primary" type="submit" disabled={!connected || saving || loading || conflict || (title !== undefined && !title.trim())}>{saving ? "Saving…" : "Save changes"}</button></div>
    </form>
  </dialog>;
}
