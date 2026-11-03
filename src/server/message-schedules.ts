import { assertDomain, DomainError } from "../domain/errors.js";
import { resolveScheduleTime } from "../domain/schedule-time.js";
import type { MessageSchedule } from "../domain/types.js";
import type { AppDatabase } from "./database.js";
import type { TaskService } from "./task-service.js";
import { requireDesignPage, selectedDesignPageId } from "./design-pages.js";
import type { ScheduleInput } from "./task-schedules.js";
import { createHash } from "node:crypto";
import { ATTACHMENT_LIMITS } from "./attachment-service.js";

export interface FollowupInput extends ScheduleInput { message?: unknown; designPageId?: unknown }

/** Future messages live in history, outside the dispatch queue, until due. */
export class MessageSchedules {
  constructor(private readonly database: AppDatabase, private readonly tasks: TaskService) {}

  get(messageId: string): MessageSchedule | null {
    return this.database.db.prepare(`SELECT message_id AS messageId, task_id AS taskId, version,
      local_time AS localTime, timezone, run_at AS runAt, policy, state, updated_at AS updatedAt, reason
      FROM message_schedules WHERE message_id=?`).get(messageId) as MessageSchedule | undefined ?? null;
  }

  eligible(taskId: string): boolean {
    const task = this.tasks.getTask(taskId);
    return (task.sessionKind ?? "codex") === "codex" && task.status !== "closed"
      && Boolean(this.database.db.prepare("SELECT 1 FROM agent_sessions WHERE owner_type='task' AND owner_id=? AND thread_id IS NOT NULL").get(task.id));
  }

  save(taskId: string, messageId: string, input: FollowupInput, submittedAt?: string): MessageSchedule {
    return this.database.db.transaction(() => {
      const task = this.tasks.getTask(taskId), current = this.get(messageId);
      assertDomain(/^[a-zA-Z0-9-]{1,100}$/.test(messageId), "Invalid message identifier", "invalid_message");
      assertDomain(!current || current.taskId === task.id, "This message is not in this chat", "message_not_found", 404);
      assertDomain(Number.isSafeInteger(input.expectedVersion) && input.expectedVersion === (current?.version ?? 0),
        "Schedule changed. Your draft is kept. Reopen it before saving.", "version_conflict", 409);
      assertDomain(!current || current.state === "pending", "Delivery has been reserved or this schedule is no longer pending", "schedule_reserved", 409);
      assertDomain(this.eligible(task.id), "Choose an existing, open Codex conversation", "session_not_started", 409);
      assertDomain(typeof input.message === "string" && input.message.trim().length > 0 && input.message.trim().length <= 30_000,
        "Message must contain between 1 and 30,000 characters", "invalid_message");
      assertDomain(typeof input.localTime === "string" && typeof input.timezone === "string" && input.timezone.length <= 100,
        "Choose a date, time and timezone", "invalid_schedule");
      assertDomain(input.policy === "when_available" || input.policy === "skip_if_missed", "Choose a missed-time policy", "invalid_schedule");
      let runAt: string;
      try { runAt = resolveScheduleTime(input.localTime, input.timezone); }
      catch (error) { throw new DomainError(error instanceof Error ? error.message : "Invalid time", "invalid_schedule"); }
      const sameTime = current?.localTime === input.localTime && current.timezone === input.timezone;
      if (sameTime) runAt = current.runAt;
      assertDomain(sameTime || Date.parse(runAt) > Date.now() || (submittedAt !== undefined && Date.parse(runAt) > Date.parse(submittedAt)), "Choose a future time", "invalid_schedule");
      const timestamp = new Date().toISOString(), text = input.message.trim();
      if (!current) {
        assertDomain(!this.database.db.prepare("SELECT 1 FROM chat_messages WHERE id=?").get(messageId), "Message identifier already used", "version_conflict", 409);
        const pageId = input.designPageId === undefined ? selectedDesignPageId(this.database.db, task.id) : input.designPageId;
        if (pageId !== null) requireDesignPage(this.database.db, task.id, pageId);
        this.database.db.prepare(`INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at)
          VALUES (?,'task',?,'user',?,?,?)`).run(messageId, task.id, text, JSON.stringify({ designPageId: pageId }), timestamp);
      } else {
        const message = this.database.db.prepare("SELECT version, body, created_at, edited_at FROM chat_messages WHERE id=?").get(messageId) as {version:number; body:string; created_at:string; edited_at:string|null};
        if (message.body !== text) {
          this.database.db.prepare("INSERT OR IGNORE INTO chat_message_versions(message_id,version,body,saved_at) VALUES (?,?,?,?)")
            .run(messageId, message.version, message.body, message.edited_at ?? message.created_at);
          this.database.db.prepare("INSERT INTO chat_message_versions(message_id,version,body,saved_at) VALUES (?,?,?,?)").run(messageId, message.version + 1, text, timestamp);
          this.database.db.prepare("UPDATE chat_messages SET body=?,version=version+1,edited_at=? WHERE id=?").run(text, timestamp, messageId);
        }
        // Moving a due message back into the future also revokes its old dispatch decision.
        if (!sameTime) this.database.db.prepare("DELETE FROM pending_messages WHERE message_id=?").run(messageId);
      }
      this.database.db.prepare(`INSERT INTO message_schedules(message_id,task_id,version,local_time,timezone,run_at,policy,state,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',?) ON CONFLICT(message_id) DO UPDATE SET version=excluded.version,
        local_time=excluded.local_time,timezone=excluded.timezone,run_at=excluded.run_at,policy=excluded.policy,updated_at=excluded.updated_at`)
        .run(messageId, task.id, (current?.version ?? 0) + 1, input.localTime, input.timezone, runAt, input.policy, timestamp);
      this.history(messageId);
      return this.get(messageId)!;
    }).immediate();
  }

  list(taskId: string): MessageSchedule[] {
    const task = this.tasks.getTask(taskId);
    return (this.database.db.prepare("SELECT message_id FROM message_schedules WHERE task_id=? ORDER BY run_at,message_id").all(task.id) as {message_id:string}[])
      .map(row => this.get(row.message_id)!);
  }

  /** One source request has one retry key, even if the tool response is lost. */
  fromChat(taskId: string, sourceMessageId: string, input: Omit<FollowupInput, "expectedVersion" | "designPageId">): MessageSchedule {
    return this.database.db.transaction(() => {
      const task = this.tasks.getTask(taskId);
      const source = this.database.db.prepare(`SELECT metadata_json,created_at FROM chat_messages
        WHERE id=? AND owner_type='task' AND owner_id=? AND role='user' AND cancelled_at IS NULL`).get(sourceMessageId, task.id) as {metadata_json:string|null;created_at:string}|undefined;
      assertDomain(source, "Choose the user's request in this conversation", "message_not_found", 404);
      assertDomain(!this.get(sourceMessageId), "This is an existing scheduled delivery; do not schedule it again", "already_scheduled", 409);
      const messageId = `followup-${createHash("sha256").update(`${task.id}:${sourceMessageId}`).digest("hex")}`;
      const existing = this.get(messageId);
      // A replay never overwrites an edit, revives cancellation, or creates another delivery.
      if (existing) return existing;
      const metadata = source.metadata_json ? JSON.parse(source.metadata_json) : {};
      const session = this.database.db.prepare("SELECT generation FROM agent_sessions WHERE owner_type='task' AND owner_id=?").get(task.id) as {generation:number}|undefined;
      const restored = this.database.db.prepare("SELECT MAX(created_at) AS at FROM session_events WHERE owner_type='task' AND owner_id=? AND event_type='session.restored'").get(task.id) as {at:string|null};
      assertDomain(metadata.sessionGeneration !== undefined ? metadata.sessionGeneration === session?.generation : !restored.at || source.created_at > restored.at,
        "The conversation was restored after this request. Ask for a new scheduling request.", "restore_conflict", 409);
      this.save(task.id, messageId, { ...input, expectedVersion: 0, timezone: input.timezone ?? metadata.submissionTimezone, designPageId: metadata.designPageId ?? null }, source.created_at);
      this.database.db.prepare("UPDATE chat_messages SET metadata_json=? WHERE id=?").run(JSON.stringify({
        designPageId: metadata.designPageId ?? null, scheduledFromMessageId: sourceMessageId,
        ...(metadata.attachments ? { attachments: metadata.attachments } : {}),
        ...(metadata.selectedExcerpt ? { selectedExcerpt: metadata.selectedExcerpt } : {}),
      }), messageId);
      // A queued request may already have missed its chosen instant. Return the
      // effective state so the reply cannot promise a delivery that was skipped.
      if (Date.parse(this.get(messageId)!.runAt) <= Date.now()) this.due();
      return this.get(messageId)!;
    }).immediate();
  }

  cancel(taskId: string, messageId: string, expectedVersion: unknown): void {
    this.database.db.transaction(() => {
      const task = this.tasks.getTask(taskId), current = this.get(messageId);
      assertDomain(current && current.taskId === task.id, "This message is not in this chat", "message_not_found", 404);
      assertDomain(Number.isSafeInteger(expectedVersion) && current.version === expectedVersion, "Schedule changed. Reopen it before removing.", "version_conflict", 409);
      assertDomain(current.state === "pending", "Delivery has been reserved or this schedule is no longer pending", "schedule_reserved", 409);
      this.setState(messageId, "cancelled", "Scheduled message removed");
    }).immediate();
  }

  setState(messageId: string, state: MessageSchedule["state"], reason: string | null = null): void {
    this.database.db.prepare("UPDATE message_schedules SET state=?,reason=?,version=version+1,updated_at=? WHERE message_id=?")
      .run(state, reason, new Date().toISOString(), messageId);
    if (!["pending", "reserved"].includes(state)) this.database.db.prepare("DELETE FROM pending_messages WHERE message_id=?").run(messageId);
    if (!["pending", "reserved"].includes(state)) this.database.db.prepare(`UPDATE attachment_uploads SET expires_at=MAX(expires_at,?) WHERE message_id=
      (SELECT json_extract(metadata_json,'$.scheduledFromMessageId') FROM chat_messages WHERE id=?)`)
      .run(new Date(Date.now() + ATTACHMENT_LIMITS.completedMs).toISOString(), messageId);
    if (state === "cancelled") this.database.db.prepare("UPDATE chat_messages SET cancelled_at=? WHERE id=?").run(new Date().toISOString(), messageId);
    this.history(messageId);
  }

  cancelTask(taskId: string, reason: string, includeReserved = false): void {
    const rows = this.database.db.prepare(`SELECT message_id FROM message_schedules WHERE task_id=? AND (state='pending' OR (? AND state='reserved'))`).all(taskId, Number(includeReserved)) as {message_id:string}[];
    for (const row of rows) this.setState(row.message_id, "cancelled", reason);
  }

  due(now = Date.now()): void {
    this.database.db.transaction(() => {
      const rows = this.database.db.prepare("SELECT message_id FROM message_schedules WHERE state='pending' ORDER BY run_at,message_id").all() as {message_id:string}[];
      for (const row of rows) {
        const current = this.get(row.message_id)!;
        if (!this.eligible(current.taskId)) this.setState(current.messageId, "cancelled", "Conversation is no longer open or available");
        else if (current.policy === "skip_if_missed" && now > Date.parse(current.runAt) + 60_000) this.setState(current.messageId, "skipped", "Delivery could not be reserved within 60 seconds");
        else if (now >= Date.parse(current.runAt)) this.database.db.prepare("INSERT OR IGNORE INTO pending_messages(message_id) VALUES (?)").run(current.messageId);
      }
    }).immediate();
  }

  reserve(messageId: string, version: number, now = Date.now()): boolean {
    return this.database.db.transaction(() => {
      const current = this.get(messageId);
      if (!current || current.version !== version || current.state !== "pending" || !this.eligible(current.taskId) || now < Date.parse(current.runAt)) return false;
      if (current.policy === "skip_if_missed" && now > Date.parse(current.runAt) + 60_000) {
        this.setState(messageId, "skipped", "Delivery window elapsed"); return false;
      }
      this.setState(messageId, "reserved");
      return true;
    }).immediate();
  }

  recover(): void {
    this.database.db.transaction(() => {
      for (const row of this.database.db.prepare("SELECT message_id FROM message_schedules WHERE state='reserved'").all() as {message_id:string}[]) {
        this.setState(row.message_id, "interrupted", "Backend restarted during delivery; inspect before retrying. Automatic retry disabled.");
      }
    }).immediate();
  }

  private history(messageId: string): void {
    const schedule = this.get(messageId)!;
    const message = this.database.db.prepare("SELECT body,version FROM chat_messages WHERE id=?").get(messageId);
    this.database.db.prepare("INSERT INTO message_schedule_history(message_id,snapshot_json,created_at) VALUES (?,?,?)")
      .run(messageId, JSON.stringify({ ...schedule, message }), new Date().toISOString());
  }
}
