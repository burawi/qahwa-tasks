import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";

/** Mount for one action and unmount on dismissal. Rejections keep the dialog open for retry. */
export function ActionDialog({ title, description, confirmLabel, pendingLabel = "Working…", destructive = false,
  disabled = false, passphrase = false, onConfirm, onClose }: {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  passphrase?: boolean;
  onConfirm: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallback = opener?.closest<HTMLElement>(".chat-session, .sheet-page, .app-shell");
    const element = dialog.current!;
    element.showModal();
    (input.current ?? cancel.current)?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (opener?.isConnected && !opener.matches(":disabled")) opener.focus({ preventScroll: true });
      else if (fallback?.isConnected) {
        const previous = fallback.getAttribute("tabindex");
        fallback.tabIndex = -1;
        fallback.focus({ preventScroll: true });
        if (previous === null) fallback.removeAttribute("tabindex");
        else fallback.setAttribute("tabindex", previous);
      }
    };
  }, []);
  const close = () => { if (!submitting.current) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || submitting.current) return;
    if (passphrase && value.length < 12) {
      setError("Export passphrase must be at least 12 characters.");
      input.current?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true); setError("");
    try { await onConfirm(value); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not complete this action. Please retry."); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="action-dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }}>
    <form className="action-dialog-form" noValidate onSubmit={submit} aria-busy={busy}>
      <div className="form-heading"><h2 id={`${id}-title`}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" disabled={busy} onClick={close}><X /></button></div>
      <p id={`${id}-description`} className="action-dialog-description">{description}</p>
      {passphrase && <label htmlFor={`${id}-passphrase`}>Export passphrase<input ref={input} id={`${id}-passphrase`} type="password" autoComplete="new-password" minLength={12}
        readOnly={busy} value={value} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : `${id}-description`}
        onChange={event => { setValue(event.target.value); setError(""); }} /></label>}
      {error && <p id={`${id}-error`} className="action-dialog-error" role="alert">{error}</p>}
      <div className="button-row"><button ref={cancel} type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button type="submit" className={destructive ? "danger-subtle" : "primary"} disabled={disabled || busy}>{busy ? pendingLabel : confirmLabel}</button></div>
    </form>
  </dialog>;
}
