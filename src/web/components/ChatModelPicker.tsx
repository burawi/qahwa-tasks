import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Cpu, X } from "lucide-react";
import type { ChatModelOption, ChatModelSettings, ChatModelSelection } from "../../domain/chat-model";
import { api } from "../api";
import "../chat-model.css";

export function ChatModelPicker({ settings, disabled, onSave }: {
  settings: ChatModelSettings;
  disabled: boolean;
  onSave: (settings: ChatModelSelection) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="chat-model-indicator" aria-label={`Model and effort: ${settings.model}, ${settings.effort}`}
      aria-haspopup="dialog" disabled={disabled} title="Change model and reasoning effort" onClick={() => setOpen(true)}>
      <Cpu aria-hidden="true" /><span>{settings.model}</span><small>{settings.effort}</small><ChevronDown aria-hidden="true" />
    </button>
    {open && <ModelDialog settings={settings} disabled={disabled} onSave={onSave} onClose={() => setOpen(false)} />}
  </>;
}

function ModelDialog({ settings, disabled, onSave, onClose }: {
  settings: ChatModelSettings; disabled: boolean;
  onSave: (settings: ChatModelSelection) => Promise<void>; onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(settings);
  const [useAsDefault, setUseAsDefault] = useState(false);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let stopped = false;
    setLoading(true); setError("");
    void api.chatModels().then(({ models }) => { if (!stopped) setModels(models); })
      .catch(error => { if (!stopped) setError(error instanceof Error ? error.message : "Could not load models. Please retry."); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [retry]);
  const model = models.find(model => model.model === selected.model);
  const supported = model?.supportedReasoningEfforts.some(option => option.reasoningEffort === selected.effort);
  const close = () => { if (!submitting.current) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || submitting.current || !supported) return;
    submitting.current = true; setBusy(true); setError("");
    try { await onSave({ ...selected, useAsDefault }); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not save. Please retry."); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="action-dialog chat-model-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form className="action-dialog-form" onSubmit={submit} aria-busy={busy || loading}>
      <div className="form-heading"><h2 id={`${id}-title`}>Model and effort</h2><button type="button" className="icon-button" aria-label="Close model picker" disabled={busy} onClick={close}><X /></button></div>
      <p id={`${id}-description`} className="action-dialog-description">Saved for this chat. Changes apply when the next turn starts.</p>
      {loading ? <p role="status">Loading models…</p> : models.length > 0 && <>
        <label htmlFor={`${id}-model`}>Model<select id={`${id}-model`} disabled={busy || disabled} value={selected.model} onChange={event => {
          const next = models.find(model => model.model === event.target.value)!;
          setSelected({ model: next.model, effort: next.supportedReasoningEfforts.some(option => option.reasoningEffort === selected.effort)
            ? selected.effort : next.defaultReasoningEffort }); setError("");
        }}>
          {!model && <option value={selected.model} disabled>{selected.model} (unavailable)</option>}
          {models.map(model => <option key={model.model} value={model.model}>{model.displayName}</option>)}
        </select></label>
        <label htmlFor={`${id}-effort`}>Reasoning effort<select id={`${id}-effort`} disabled={busy || disabled || !model} value={selected.effort} onChange={event => {
          setSelected(current => ({ ...current, effort: event.target.value })); setError("");
        }}>
          {!supported && <option value={selected.effort} disabled>{selected.effort} (unavailable)</option>}
          {model?.supportedReasoningEfforts.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
        </select></label>
        {model && <p className="chat-model-effort-description">{model.supportedReasoningEfforts.find(option => option.reasoningEffort === selected.effort)?.description}</p>}
      </>}
      {!loading && models.length > 0 && <label className="chat-model-default-option">
        <input type="checkbox" checked={useAsDefault} disabled={busy || disabled} onChange={event => setUseAsDefault(event.target.checked)} />
        <span>Use as default for new chats<small>Existing chats keep their settings.</small></span>
      </label>}
      {error && <p className="action-dialog-error" role="alert">{error}</p>}
      <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        {!loading && !models.length ? <button key="retry" type="button" className="primary" disabled={disabled} onClick={event => { event.preventDefault(); setRetry(current => current + 1); }}>Retry</button>
          : <button key="save" type="submit" className="primary" disabled={disabled || busy || loading || !supported}>{busy ? "Saving…" : "Save"}</button>}
      </div>
    </form>
  </dialog>;
}
