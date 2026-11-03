import { useEffect, useId, useRef, useState } from "react";
import type { ChatMessage, TaskWorkspace } from "../../domain/types";
import { resolveScheduleTime, scheduleZoneLabel } from "../../domain/schedule-time";
import { api } from "../api";
import "../task-schedule.css";

interface Props {
  taskId: string; message: ChatMessage; disabled: boolean;
  onChanged: (workspace: TaskWorkspace) => void;
}

export function FollowupSchedule({ taskId, message, disabled, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const schedule = message.schedule;
  return <>
    {schedule && <div className="followup-schedule-status" role="status">
      <strong>{({ pending: "Scheduled follow-up", reserved: "Delivering scheduled follow-up", delivered: "Scheduled follow-up delivered", skipped: "Scheduled follow-up skipped", cancelled: "Scheduled follow-up removed", interrupted: "Scheduled follow-up interrupted" })[schedule.state]}</strong>
      <span>{schedule.localTime.replace("T", " · ")} · {scheduleZoneLabel(schedule.runAt, schedule.timezone)}</span>
      <small>{schedule.state === "pending" ? schedule.policy === "when_available" ? "Run when available · waits for current work, capacity and worktree." : "Skip if missed · 60-second delivery window." : schedule.reason}</small>
    </div>}
    {(schedule?.state === "pending") && <button type="button" className="message-edit" disabled={disabled}
      onClick={() => setEditing(true)}>Edit scheduled message</button>}
    {editing && <FollowupEditor taskId={taskId} message={message} disabled={disabled}
      onChanged={onChanged} onClose={() => setEditing(false)} />}
  </>;
}

function FollowupEditor({ taskId, message, disabled, onChanged, onClose }: Props & { onClose: () => void }) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), first = useRef<HTMLTextAreaElement>(null), submitting = useRef(false);
  const [messageId] = useState(message.id);
  const [version] = useState(message?.schedule?.version ?? 0);
  const [text, setText] = useState(message?.body ?? "");
  const [localTime, setLocalTime] = useState(message?.schedule?.localTime ?? "");
  const [timezone, setTimezone] = useState(message?.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [policy, setPolicy] = useState(message?.schedule?.policy ?? "when_available");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  let preview = "";
  try { if (localTime) preview = scheduleZoneLabel(resolveScheduleTime(localTime, timezone), timezone); } catch { /* Validate on save. */ }
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current!.showModal(); first.current?.focus();
    return () => { dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const close = () => { if (!submitting.current) onClose(); };
  const save = async (remove = false) => {
    if (disabled || submitting.current) return;
    setError("");
    if (!remove) {
      try {
        if (!text.trim() || text.trim().length > 30_000) throw new Error("Enter a message of at most 30,000 characters");
        const runAt = resolveScheduleTime(localTime, timezone);
        if (Date.parse(runAt) <= Date.now() && !(message?.schedule?.localTime === localTime && message.schedule.timezone === timezone)) throw new Error("Choose a future time");
      } catch (error) { setError(error instanceof Error ? error.message : "Choose a valid time"); return; }
    }
    submitting.current = true; setBusy(true);
    try {
      const result = remove ? await api.cancelFollowup(taskId, messageId, version)
        : await api.saveFollowup(taskId, messageId, { expectedVersion: version, message: text, localTime, timezone, policy });
      // Acceptance is durable even if a later refresh fails.
      onChanged(result.workspace); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update schedule. Your draft is kept."); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="action-dialog schedule-dialog" aria-modal="true" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form className="action-dialog-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2 id={`${id}-title`}>Edit scheduled message</h2>
      <p>Continue this conversation once at the chosen time, with its existing context and permissions. Waits for the current turn to finish.</p>
      <label htmlFor={`${id}-message`}>Follow-up message</label><textarea id={`${id}-message`} ref={first} rows={4} required maxLength={30_000} value={text} disabled={busy} onChange={event => setText(event.target.value)} />
      <label>Date and time<input type="datetime-local" step="60" required value={localTime} disabled={busy} onChange={event => setLocalTime(event.target.value)} /></label>
      <label>Timezone<input list={`${id}-zones`} required value={timezone} disabled={busy} onChange={event => setTimezone(event.target.value)} placeholder="Africa/Tunis" /></label>
      <datalist id={`${id}-zones`}>{[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC", "Africa/Tunis", "Europe/Paris", "Europe/London", "America/New_York", "Asia/Tokyo"])].map(zone => <option key={zone} value={zone} />)}</datalist>
      <p className="schedule-timezone" aria-live="polite">{preview || `${timezone} · choose a valid local time to see its UTC offset`}</p>
      <label htmlFor={`${id}-policy`}>If the time is missed</label><select id={`${id}-policy`} value={policy} disabled={busy} onChange={event => setPolicy(event.target.value as typeof policy)}>
        <option value="when_available">Run when available</option><option value="skip_if_missed">Skip if missed</option>
      </select>
      <p>{policy === "when_available" ? "Never runs early. Waits for current work, capacity and worktree availability, including after downtime." : "Allows delivery reservation through 60 seconds after the chosen time. Otherwise skips and leaves the conversation open."}</p>
      {error && <p role="alert" className="action-dialog-error">{error}</p>}
      <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="danger-subtle" disabled={busy || disabled} onClick={() => void save(true)}>Remove schedule</button>
        <button type="submit" className="primary" disabled={busy || disabled}>{busy ? "Saving…" : "Save schedule"}</button></div>
    </form>
  </dialog>;
}
