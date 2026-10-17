import type { AppDatabase } from "./database.js";
import { QahwaNotifier } from "./notifier.js";

interface OutboxRow {
  id: string;
  event_type: "started" | "review" | "response_required";
  payload_json: string;
  attempts: number;
}

export class NotificationWorker {
  private timer: NodeJS.Timeout | null = null;
  private working = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly notifier: QahwaNotifier,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.process(), 5_000);
    void this.process();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async process(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      const rows = this.database.db.prepare(`
        SELECT id, event_type, payload_json, attempts FROM notification_outbox
        WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 10
      `).all(new Date().toISOString()) as OutboxRow[];
      for (const row of rows) await this.deliver(row);
    } finally {
      this.working = false;
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, string>;
      await this.notifier.send({
        taskHumanId: payload.taskHumanId ?? "Task",
        taskTitle: payload.taskTitle ?? "Untitled",
        projectName: payload.projectName ?? "",
        event: row.event_type,
        eventId: row.id,
      });
      this.database.db.prepare(`
        UPDATE notification_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?
      `).run(new Date().toISOString(), row.id);
    } catch (error) {
      const attempts = row.attempts + 1;
      const terminal = attempts >= 8;
      const delayMinutes = Math.min(60, 2 ** attempts);
      this.database.db.prepare(`
        UPDATE notification_outbox
        SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?
      `).run(
        terminal ? "failed" : "pending",
        attempts,
        error instanceof Error ? error.message.slice(0, 500) : "Unknown notification error",
        new Date(Date.now() + delayMinutes * 60_000).toISOString(),
        row.id,
      );
    }
  }
}
