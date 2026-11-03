import { randomUUID } from "node:crypto";
import { fallbackTaskTitle, parseGeneratedTaskTitle } from "../domain/task-title.js";
import { plainTextFromDocument, type RichTextDocument } from "../domain/types.js";
import type { AppDatabase } from "./database.js";
import type { TaskService } from "./task-service.js";
import { assertDomain } from "../domain/errors.js";

export type TaskTitleGenerator = (note: string, signal: AbortSignal) => Promise<string>;

interface TitleJob {
  task_id: string;
  source_version: number;
  source_title: string;
  description_json: string;
  claim_token: string;
}

export class TaskTitleService {
  private timer?: NodeJS.Timeout;
  private active?: Promise<boolean>;
  private controller?: AbortController;
  private closed = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly tasks: TaskService,
    private readonly generate: TaskTitleGenerator,
    private readonly timeoutMs = 45_000,
  ) {}

  start(): void {
    if (this.timer || this.closed) return;
    // Saving a task never waits for inference. One title at a time, outside the task scheduler.
    this.timer = setInterval(() => { void this.runNext().catch(() => undefined); }, 2_000);
    this.timer.unref();
  }

  requestBackfill(taskIds: unknown): number {
    assertDomain(Array.isArray(taskIds) && taskIds.length > 0 && taskIds.length <= 100
      && taskIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 100),
    "Choose 1–100 task identifiers for explicit title backfill", "invalid_title_backfill");
    return this.database.db.transaction(() => {
      // This operation is called only by an explicit, authenticated request with
      // a finite task selection. Startup never enrolls or authorizes backfill.
      const ids = [...new Set(taskIds.map(id => this.tasks.getTask(id).id))];
      const rows = this.database.db.prepare(`
        SELECT t.id, t.title, t.description_json, t.version, v.actor,
          v.title AS original_title, v.description_json AS original_description
        FROM tasks t JOIN task_versions v ON v.task_id = t.id AND v.version = 1
        LEFT JOIN task_title_jobs j ON j.task_id = t.id
        WHERE t.id IN (${ids.map(() => "?").join(",")})
          AND t.status != 'closed' AND t.title_source IN ('unknown','fallback')
          AND (SELECT COUNT(*) FROM task_versions h WHERE h.task_id = t.id) = 1
          AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.task_id = t.id AND a.event_type = 'task.edited')
          AND (j.task_id IS NULL OR (
            j.origin = 'unclassified' AND (j.state = 'pending' OR (j.state = 'running' AND j.lease_until <= ?))
            AND j.source_version = t.version AND j.source_title = t.title AND j.description_json = t.description_json
          ))
      `).all(...ids, new Date().toISOString()) as Array<{
        id: string; title: string; description_json: string; version: number;
        actor: string; original_title: string; original_description: string;
      }>;
      let count = 0;
      for (const row of rows) {
        // A short first-line match could be a deliberate manual title. Only the old
        // 97-character + ellipsis truncation, with untouched user history, is strong evidence.
        if (row.actor !== "user" || row.title !== row.original_title
          || row.description_json !== row.original_description) continue;
        let note: string;
        try { note = plainTextFromDocument(JSON.parse(row.description_json) as RichTextDocument); }
        catch { continue; }
        if ((note.trim().split("\n").find(Boolean)?.length ?? 0) <= 100
          || row.title !== fallbackTaskTitle(note)) continue;
        const timestamp = new Date().toISOString();
        this.database.db.prepare(`INSERT INTO task_title_jobs
          (task_id, origin, source_version, source_title, description_json, created_at, updated_at)
          VALUES (?, 'backfill', ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET origin = 'backfill', state = 'pending',
            claim_token = NULL, lease_until = NULL, last_error = NULL, updated_at = excluded.updated_at`)
          .run(row.id, row.version, row.title, row.description_json, timestamp, timestamp);
        this.database.db.prepare("UPDATE tasks SET title_source = 'fallback' WHERE id = ?").run(row.id);
        count += 1;
      }
      return count;
    })();
  }

  runNext(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.active) return this.active;
    this.active = this.processNext().finally(() => { this.active = undefined; });
    return this.active;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.active;
  }

  private claim(): TitleJob | undefined {
    return this.database.db.transaction(() => {
      const timestamp = new Date().toISOString();
      this.database.db.prepare(`UPDATE task_title_jobs SET
        state = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
        claim_token = NULL, lease_until = NULL, updated_at = ?
        WHERE origin IN ('new_task','backfill') AND state = 'running' AND lease_until <= ?`).run(timestamp, timestamp);
      const row = this.database.db.prepare(`SELECT * FROM task_title_jobs
        WHERE origin IN ('new_task','backfill') AND state = 'pending'
        ORDER BY created_at, task_id LIMIT 1`).get() as TitleJob | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      // A lease outlives the inference timeout, so another process cannot duplicate an active request.
      this.database.db.prepare(`UPDATE task_title_jobs SET state = 'running', claim_token = ?,
        lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE task_id = ?`)
        .run(token, new Date(Date.now() + this.timeoutMs + 60_000).toISOString(), timestamp, row.task_id);
      return { ...row, claim_token: token };
    })();
  }

  private isCurrent(job: TitleJob): boolean {
    return Boolean(this.database.db.prepare(`SELECT t.id FROM tasks t JOIN task_title_jobs j ON j.task_id = t.id
      WHERE t.id = ? AND t.title_source = 'fallback' AND t.status != 'closed'
        AND t.version = ? AND t.title = ? AND t.description_json = ?
        AND j.origin IN ('new_task','backfill') AND j.state = 'running' AND j.claim_token = ? AND j.lease_until > ?`)
      .get(job.task_id, job.source_version, job.source_title, job.description_json, job.claim_token, new Date().toISOString()));
  }

  private finish(job: TitleJob, state: string, error: string | null = null): void {
    this.database.db.prepare(`UPDATE task_title_jobs SET state = ?, last_error = ?, claim_token = NULL,
      lease_until = NULL, updated_at = ? WHERE task_id = ? AND state = 'running' AND claim_token = ?`)
      .run(state, error, new Date().toISOString(), job.task_id, job.claim_token);
  }

  private async processNext(): Promise<boolean> {
    const job = this.claim();
    if (!job) return false;
    if (!this.isCurrent(job)) { this.finish(job, "skipped"); return true; }
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let abortListener: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(new Error("Title generation interrupted"));
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      const note = plainTextFromDocument(JSON.parse(job.description_json) as RichTextDocument);
      const output = await Promise.race([this.generate(note, controller.signal), aborted]);
      const title = parseGeneratedTaskTitle(output);
      this.database.db.transaction(() => {
        if (!this.isCurrent(job)) { this.finish(job, "skipped"); return; }
        this.tasks.updateTask(job.task_id, { title, expectedVersion: job.source_version }, "system");
        this.database.db.prepare("UPDATE tasks SET title_source = 'generated' WHERE id = ?").run(job.task_id);
        this.finish(job, "generated");
      })();
    } catch {
      // Keep the original fallback on service/auth/model/output failures. No retry loop or paid fallback.
      this.finish(job, this.closed ? "pending" : "failed", this.closed ? null : "Title generation failed; fallback preserved");
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abortListener!);
      this.controller = undefined;
    }
    return true;
  }
}
