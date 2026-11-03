import type { ChatMessage, GuidanceDelivery } from "../domain/types.js";
import type { AppDatabase } from "./database.js";

export interface GuidanceRow {
  message_id: string;
  task_id: string;
  status: GuidanceDelivery["status"];
  phase: "queued" | "steer" | "start";
  detail: string;
  uncertain: number;
  thread_id: string | null;
  expected_turn_id: string | null;
  turn_id: string | null;
}

/** The saved task message is the only delivery intent. Both chats read this receipt. */
export class GuidanceDeliveries {
  constructor(private readonly database: AppDatabase) {}

  get(messageId: string): GuidanceRow | undefined {
    return this.database.db.prepare("SELECT * FROM guidance_deliveries WHERE message_id=?").get(messageId) as GuidanceRow | undefined;
  }

  update(messageId: string, status: GuidanceRow["status"], detail: string, options: {
    phase?: GuidanceRow["phase"]; uncertain?: boolean; threadId?: string; expectedTurnId?: string; turnId?: string;
  } = {}): void {
    this.database.db.prepare(`UPDATE guidance_deliveries SET status=?,detail=?,uncertain=?,
      phase=COALESCE(?,phase),thread_id=COALESCE(?,thread_id),expected_turn_id=COALESCE(?,expected_turn_id),
      turn_id=COALESCE(?,turn_id),updated_at=? WHERE message_id=?`)
      .run(status, detail, options.uncertain ? 1 : 0, options.phase ?? null, options.threadId ?? null,
        options.expectedTurnId ?? null, options.turnId ?? null, new Date().toISOString(), messageId);
  }

  recover(): void {
    this.database.db.prepare(`UPDATE guidance_deliveries SET status='pending',
      detail='Saved. Queued for the next available task turn.',updated_at=? WHERE status='saved'`).run(new Date().toISOString());
    // The previous process may have sent a request but died before saving its ack.
    this.database.db.prepare(`UPDATE guidance_deliveries SET status='failed',uncertain=1,
      detail='Saved. Delivery outcome unknown after restart; inspect the target conversation before retrying.',updated_at=?
      WHERE status='pending' AND phase IN ('steer','start')`).run(new Date().toISOString());
  }

  observe(threadId: string | null, turnId: string | null, clientId: unknown): void {
    if (!threadId || !turnId || typeof clientId !== "string") return;
    const receipt = this.get(clientId);
    if (!receipt || receipt.thread_id !== threadId || receipt.status === "delivered"
      || (receipt.status === "failed" && !receipt.uncertain)
      || receipt.phase === "queued" || (receipt.phase === "steer" && receipt.expected_turn_id !== turnId)) return;
    this.database.db.transaction(() => {
      this.update(clientId, "delivered", "Codex recorded the guidance input in the target conversation.", { turnId });
      this.database.db.prepare("DELETE FROM pending_messages WHERE message_id=?").run(clientId);
    }).immediate();
  }

  decorate(message: ChatMessage): ChatMessage {
    const rows = this.database.db.prepare(`SELECT g.*,t.human_id,t.title FROM guidance_deliveries g
      JOIN tasks t ON t.id=g.task_id WHERE g.message_id=? OR g.source_message_id=? ORDER BY g.rowid`)
      .all(message.id, message.id) as Array<GuidanceRow & { human_id: string; title: string }>;
    if (!rows.length) {
      // Old guidance notes were saved before the RPC and have no delivery proof.
      if (message.ownerType !== "task" || message.role !== "system"
        || !/^[^\n]{1,160} guidance(?: authorized by the user)?:/i.test(message.body)) return message;
      const task = this.database.db.prepare("SELECT human_id,title FROM tasks WHERE id=?").get(message.ownerId) as { human_id: string; title: string } | undefined;
      if (!task) return message;
      return { ...message, guidanceDeliveries: [{ messageId: message.id, taskId: task.human_id, taskTitle: task.title,
        status: "saved", detail: "Saved before delivery tracking. Delivery is unconfirmed; check later guidance and task replies before resending.",
        uncertain: true, expectedTurnId: null, turnId: null }] };
    }
    return { ...message, guidanceDeliveries: rows.map(row => ({ messageId: row.message_id, taskId: row.human_id,
      taskTitle: row.title, status: row.status, detail: row.detail, uncertain: Boolean(row.uncertain),
      expectedTurnId: row.expected_turn_id, turnId: row.turn_id })) };
  }
}

export function rejectedCodexRequest(error: unknown): boolean {
  return error instanceof Error && [-32600, -32601, -32602].includes((error as Error & { code?: number }).code ?? 0);
}

export function staleGuidanceTurn(error: unknown): boolean {
  return rejectedCodexRequest(error) && /no active turn|no turn (?:is )?(?:running|in progress)|expected(?:TurnId| turn(?: id)?).*(?:mismatch|does not match|got|but)|turn.*(?:mismatch|does not match|not active)/i.test((error as Error).message);
}
