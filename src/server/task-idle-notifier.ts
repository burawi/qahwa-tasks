import type { AppDatabase } from "./database.js";
import type { AppPushService } from "./app-push-service.js";

/** Only the opted-in task turn-completion path may call this sender. */
export class TaskIdleNotifier {
  constructor(private readonly database: AppDatabase, private readonly push: Pick<AppPushService, "send">) {}

  async completed(taskId: string, threadId: string, turnId: string): Promise<void> {
    let claimed = false;
    try {
      const task = this.database.db.prepare(`SELECT t.human_id, t.title, p.name AS project_name FROM tasks t
        JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.idle_notifications_enabled = 1`)
        .get(taskId) as { human_id: string; title: string; project_name: string } | undefined;
      if (!task) return;
      // Claim before any asynchronous work. Keep the receipt across reloads/restarts,
      // including failures: duplicate protocol events must never send another alert.
      claimed = this.database.db.prepare(`INSERT OR IGNORE INTO task_idle_notifications
        (task_id, thread_id, turn_id, status, created_at) VALUES (?, ?, ?, 'sending', ?)`)
        .run(taskId, threadId, turnId, new Date().toISOString()).changes === 1;
      if (!claimed) return;
      const delivered = await this.push.send({
        title: "Task is idle",
        body: `${task.human_id} · ${task.title}\n${task.project_name}`,
        url: `/tasks/${encodeURIComponent(task.human_id)}`,
        tag: `task-idle:${taskId}:${threadId}:${turnId}`,
      });
      if (!delivered) throw new Error("No app notification delivered");
      this.setStatus(taskId, threadId, turnId, "sent");
    } catch {
      // Do not leak credentials/provider responses or affect task state/queue progress.
      if (claimed) this.setStatus(taskId, threadId, turnId, "failed");
    }
  }

  private setStatus(taskId: string, threadId: string, turnId: string, status: "sent" | "failed"): void {
    try {
      this.database.db.prepare("UPDATE task_idle_notifications SET status = ? WHERE task_id = ? AND thread_id = ? AND turn_id = ?")
        .run(status, taskId, threadId, turnId);
    } catch { /* The app may have shut down while delivery was in flight. */ }
  }
}
