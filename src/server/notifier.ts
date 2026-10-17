import { readFileSync } from "node:fs";
import type { Config } from "./config.js";

interface Notification {
  taskHumanId: string;
  taskTitle: string;
  projectName: string;
  event: "started" | "review" | "response_required";
  eventId: string;
}

const TITLES: Record<Notification["event"], string> = {
  started: "Task started",
  review: "Task ready for review",
  response_required: "Codex needs your response",
};

export class QahwaNotifier {
  constructor(private readonly config: Config) {}

  async send(notification: Notification): Promise<void> {
    const token = readFileSync(this.config.qahwaNotifyTokenFile, "utf8").trim();
    const response = await fetch(`${this.config.qahwaNotifyUrl}/v1/notifications`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `qahwa-tasks:${notification.event}:${notification.eventId}`,
      },
      body: JSON.stringify({
        title: TITLES[notification.event],
        body: `${notification.taskHumanId} · ${notification.taskTitle}\n${notification.projectName}`,
        source: "qahwa-tasks",
        channel: "tasks",
        priority: "high",
        url: `${this.config.publicBaseUrl}/tasks/${encodeURIComponent(notification.taskHumanId)}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Qahwa Notify returned HTTP ${response.status}`);
  }
}
