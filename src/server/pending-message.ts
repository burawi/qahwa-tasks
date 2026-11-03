import { assertDomain } from "../domain/errors.js";
import type { SessionOwnerType } from "../domain/types.js";
import type { AppDatabase } from "./database.js";

/** Shared by saved-message controls; call inside the dispatch reservation transaction. */
export function pendingMessageMutable(state: {
  id: string; role: string; pending: boolean; cancelledAt?: string | null;
  startingMessageId: string | null; taskClosed: boolean;
}): boolean {
  return state.role === "user" && state.pending && !state.cancelledAt
    && state.startingMessageId !== state.id && !state.taskClosed;
}

export function requireMutablePendingMessage(database: AppDatabase, ownerType: SessionOwnerType, ownerId: string, messageId: string): void {
  const row = database.db.prepare(`SELECT m.id, m.role, m.cancelled_at AS cancelledAt,
    EXISTS(SELECT 1 FROM pending_messages p WHERE p.message_id = m.id) AS pending,
    s.starting_message_id AS startingMessageId,
    EXISTS(SELECT 1 FROM tasks t WHERE t.id = m.owner_id AND m.owner_type = 'task' AND t.status = 'closed') AS taskClosed
    FROM chat_messages m LEFT JOIN agent_sessions s ON s.owner_type = m.owner_type AND s.owner_id = m.owner_id
    WHERE m.id = ? AND m.owner_type = ? AND m.owner_id = ?`)
    .get(messageId, ownerType, ownerId) as { id: string; role: string; cancelledAt: string | null; pending: number; startingMessageId: string | null; taskClosed: number } | undefined;
  assertDomain(row, "This message is not in this chat", "message_not_found", 404);
  assertDomain(pendingMessageMutable({ ...row, pending: Boolean(row.pending), taskClosed: Boolean(row.taskClosed) }),
    "This message is starting, already processed, cancelled, or no longer pending. Refresh the chat.", "message_not_pending", 409);
}
