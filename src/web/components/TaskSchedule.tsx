import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { TaskSchedule as Schedule } from "../../domain/types";
import { resolveScheduleTime, scheduleZoneLabel } from "../../domain/schedule-time";
import { api } from "../api";
import "../task-schedule.css";

export function TaskSchedule({ taskId, schedule, eligible, disabled, onChanged }: {
  taskId: string; schedule: Schedule | null; eligible: boolean; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const editable = eligible && (!schedule || ["pending", "skipped", "cancelled"].includes(schedule.state));
  return <>
    {(editable || schedule) && <div className="task-schedule-bar">
      <div role="status">{schedule ? <><strong>{({ pending: "Scheduled", reserved: "Starting", started: "Scheduled start dispatched", skipped: "Schedule skipped", cancelled: "Schedule removed", interrupted: "Scheduled start interrupted" })[schedule.state]}</strong>
        <span>{schedule.localTime.replace("T", " · ")} · {scheduleZoneLabel(schedule.runAt, schedule.timezone)}</span>
        <small>{schedule.state === "pending" ? schedule.policy === "when_available" ? "Waits for capacity and the worktree; never starts early." : "Skips if startup is not reserved within 60 seconds." : schedule.reason}</small></> : <span>Choose when this task begins intake.</span>}</div>
      {editable && <button type="button" className="secondary" disabled={disabled} onClick={() => setEditing(true)}>{schedule?.state === "pending" ? "Edit schedule" : "Schedule start"}</button>}
    </div>}
    {editing && <ScheduleEditor taskId={taskId} schedule={schedule} disabled={disabled} onChanged={onChanged} onClose={() => setEditing(false)} />}
  </>;
}

function ScheduleEditor({ taskId, schedule, disabled, onChanged, onClose }: {
  taskId: string; schedule: Schedule | null; disabled: boolean; onChanged: () => Promise<void>; onClose: () => void;
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), first = useRef<HTMLInputElement>(null), submitting = useRef(false);
  // Freeze the version when opened. Polling must never overwrite a draft or authorize a stale save.
  const [version] = useState(schedule?.version ?? 0);
  const [localTime, setLocalTime] = useState(schedule?.localTime ?? "");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [policy, setPolicy] = useState(schedule?.policy ?? "when_available");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  let preview = "";
  try { if (localTime) preview = scheduleZoneLabel(resolveScheduleTime(localTime, timezone), timezone); } catch { /* Show validation on submit. */ }
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
      try { const runAt = resolveScheduleTime(localTime, timezone); if (Date.parse(runAt) <= Date.now()) throw new Error("Choose a future time"); }
      catch (error) { setError(error instanceof Error ? error.message : "Choose a valid time"); return; }
    }
    submitting.current = true; setBusy(true);
    try {
      if (remove) await api.cancelSchedule(taskId, version);
      else await api.saveSchedule(taskId, { expectedVersion: version, localTime, timezone, policy });
      await onChanged(); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update schedule. Your draft is kept."); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="action-dialog schedule-dialog" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}>
    <form className="action-dialog-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void save(); }} aria-busy={busy}>
      <h2 id={`${id}-title`}>{schedule?.state === "pending" ? "Edit schedule" : "Schedule start"}</h2>
      <p>Start intake once at the chosen time. Scheduling grants no extra permission to implement, deploy, or close this task.</p>
      <label>Date and time<input ref={first} type="datetime-local" step="60" required value={localTime} disabled={busy} onChange={event => setLocalTime(event.target.value)} /></label>
      <label>Timezone<input list={`${id}-zones`} required value={timezone} disabled={busy} onChange={event => setTimezone(event.target.value)} placeholder="Africa/Tunis" /></label>
      <datalist id={`${id}-zones`}>{[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC", "Africa/Tunis", "Europe/Paris", "Europe/London", "America/New_York", "Asia/Tokyo"])].map(zone => <option key={zone} value={zone} />)}</datalist>
      <p className="schedule-timezone" aria-live="polite">{preview || `${timezone} · choose a valid local time to see its UTC offset`}</p>
      <label htmlFor={`${id}-policy`}>If the time is missed</label><select id={`${id}-policy`} value={policy} disabled={busy} onChange={event => setPolicy(event.target.value as Schedule["policy"])}>
        <option value="when_available">Run when available</option><option value="skip_if_missed">Skip if missed</option>
      </select>
      <p>{policy === "when_available" ? "Never starts early. Waits for capacity or worktree availability, including after downtime." : "Allows startup reservation through 60 seconds after the chosen time. Otherwise skips and leaves the task open."}</p>
      {error && <p role="alert" className="action-dialog-error">{error}</p>}
      <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        {schedule?.state === "pending" && <button type="button" className="danger-subtle" disabled={busy || disabled} onClick={() => void save(true)}>Remove schedule</button>}
        <button type="submit" className="primary" disabled={busy || disabled}>{busy ? "Saving…" : "Save schedule"}</button></div>
    </form>
  </dialog>;
}
