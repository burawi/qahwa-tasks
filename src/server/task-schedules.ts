import { assertDomain, DomainError } from "../domain/errors.js";
import type { TaskSchedule } from "../domain/types.js";
import { resolveScheduleTime } from "../domain/schedule-time.js";
import type { AppDatabase } from "./database.js";
import type { TaskService } from "./task-service.js";

export interface ScheduleInput { expectedVersion?: unknown; localTime?: unknown; timezone?: unknown; policy?: unknown }
export class TaskSchedules {
  constructor(private readonly database: AppDatabase, private readonly tasks: TaskService) {}
  get(taskId: string): TaskSchedule | null {
    return this.database.db.prepare(`SELECT task_id AS taskId, version, local_time AS localTime, timezone,
      run_at AS runAt, policy, state, updated_at AS updatedAt, reason FROM task_schedules WHERE task_id = ?`).get(taskId) as TaskSchedule | undefined ?? null;
  }
  eligible(taskId: string): boolean {
    const task = this.tasks.getTask(taskId);
    return (task.sessionKind ?? "codex") === "codex" && ["backlog", "todo"].includes(task.status)
      && task.sessionState === "not_started"
      && !this.database.db.prepare(`SELECT 1 FROM agent_sessions WHERE owner_type='task' AND owner_id=?
        AND (thread_id IS NOT NULL OR starting_message_id IS NOT NULL)`).get(task.id)
      && !this.database.db.prepare("SELECT 1 FROM chat_messages WHERE owner_type='task' AND owner_id=? AND COALESCE(json_extract(metadata_json,'$.taskCreation'),0) != 1").get(task.id)
      && !this.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id=?").get(task.id)
      && !this.database.db.prepare("SELECT 1 FROM scheduler_runs WHERE task_id=? AND decision='started'").get(task.id);
  }
  save(id: string, input: ScheduleInput): TaskSchedule {
    return this.database.db.transaction(() => {
      const task = this.tasks.getTask(id);
      const current = this.get(task.id);
      assertDomain(Number.isSafeInteger(input.expectedVersion) && input.expectedVersion === (current?.version ?? 0), "Schedule changed. Reload before saving.", "version_conflict", 409);
      assertDomain(!current || ["pending", "cancelled", "skipped"].includes(current.state), "Startup has already been reserved", "schedule_reserved", 409);
      assertDomain(this.eligible(task.id), "Only unstarted Codex tasks can be scheduled", "task_started", 409);
      assertDomain(typeof input.localTime === "string" && typeof input.timezone === "string" && input.timezone.length <= 100, "Choose a date, time and timezone", "invalid_schedule");
      assertDomain(input.policy === "when_available" || input.policy === "skip_if_missed", "Choose a missed-time policy", "invalid_schedule");
      let runAt: string;
      try { runAt = resolveScheduleTime(input.localTime, input.timezone); }
      catch (error) { throw new DomainError(error instanceof Error ? error.message : "Invalid time", "invalid_schedule"); }
      assertDomain(Date.parse(runAt) > Date.now(), "Choose a future time", "invalid_schedule");
      const timestamp = new Date().toISOString();
      this.database.db.prepare(`INSERT INTO task_schedules (task_id,version,local_time,timezone,run_at,policy,state,updated_at,reason)
        VALUES (?,?,?,?,?,?,'pending',?,NULL) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,
        local_time=excluded.local_time,timezone=excluded.timezone,run_at=excluded.run_at,policy=excluded.policy,state='pending',updated_at=excluded.updated_at,reason=NULL`)
        .run(task.id, (current?.version ?? 0) + 1, input.localTime, input.timezone, runAt, input.policy, timestamp);
      this.history(task.id);
      return this.get(task.id)!;
    }).immediate();
  }
  cancel(id: string, expectedVersion: unknown): TaskSchedule {
    return this.database.db.transaction(() => {
      const task = this.tasks.getTask(id), current = this.get(task.id);
      assertDomain(current && current.version === expectedVersion, "Schedule changed. Reload before removing it.", "version_conflict", 409);
      assertDomain(current.state === "pending", "Startup has already been reserved", "schedule_reserved", 409);
      return this.setState(task.id, "cancelled", "Schedule removed; task remains open");
    }).immediate();
  }
  setState(taskId: string, state: TaskSchedule["state"], reason: string | null = null): TaskSchedule {
    this.database.db.prepare("UPDATE task_schedules SET state=?,reason=?,version=version+1,updated_at=? WHERE task_id=?")
      .run(state, reason, new Date().toISOString(), taskId);
    this.history(taskId);
    return this.get(taskId)!;
  }
  due(now = Date.now()): TaskSchedule[] {
    return this.database.db.transaction(() => {
      const pending = this.database.db.prepare("SELECT task_id FROM task_schedules WHERE state='pending' ORDER BY run_at,task_id").all() as {task_id:string}[];
      const due: TaskSchedule[] = [];
      for (const {task_id} of pending) {
        const schedule = this.get(task_id)!;
        if (!this.eligible(task_id)) this.setState(task_id, "cancelled", "Task is no longer unstarted");
        else if (schedule.policy === "skip_if_missed" && now > Date.parse(schedule.runAt) + 60_000) this.setState(task_id, "skipped", "Startup could not be reserved within 60 seconds");
        else if (now >= Date.parse(schedule.runAt)) due.push(schedule);
      }
      return due;
    }).immediate();
  }
  reserve(taskId: string, version: number, now = Date.now()): boolean {
    return this.database.db.transaction(() => {
      const current = this.get(taskId);
      if (!current || current.version !== version || current.state !== "pending" || now < Date.parse(current.runAt)) return false;
      if (current.policy === "skip_if_missed" && now > Date.parse(current.runAt) + 60_000) { this.setState(taskId, "skipped", "Startup window elapsed"); return false; }
      this.setState(taskId, "reserved");
      return true;
    }).immediate();
  }
  recover(): void {
    this.database.db.transaction(() => {
      for (const row of this.database.db.prepare("SELECT task_id FROM task_schedules WHERE state='reserved'").all() as {task_id:string}[]) {
        this.setState(row.task_id, "interrupted", "Backend restarted during startup; automatic retry disabled");
        this.database.db.prepare(`DELETE FROM pending_messages WHERE message_id IN (SELECT id FROM chat_messages
          WHERE owner_type='task' AND owner_id=? AND json_extract(metadata_json,'$.scheduleVersion') IS NOT NULL)`).run(row.task_id);
        this.database.db.prepare("UPDATE agent_sessions SET run_state='interrupted',active_turn_id=NULL,starting_message_id=NULL,last_error=? WHERE owner_type='task' AND owner_id=?")
          .run("Scheduled startup interrupted; inspect before retrying", row.task_id);
      }
    }).immediate();
  }
  private history(taskId: string): void {
    this.database.db.prepare("INSERT INTO task_schedule_history(task_id,snapshot_json,created_at) VALUES (?,?,?)")
      .run(taskId, JSON.stringify(this.get(taskId)), new Date().toISOString());
  }
}
