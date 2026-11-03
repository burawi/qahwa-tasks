import type { ChatReadState, SessionOwnerType } from "../domain/types.js";
import { assertDomain } from "../domain/errors.js";
import type { AppDatabase } from "./database.js";

// Only completed, visible replies are persisted as assistant messages. System
// observations and silent turns must never contribute to the user's badge.
const visibleReply = `m.role = 'assistant' AND COALESCE(json_extract(m.metadata_json, '$.queueScheduling'), 0) != 1`;

export class MessageReadService {
  constructor(private readonly database: AppDatabase) {}

  unread(ownerType: SessionOwnerType, ownerId: string): ChatReadState {
    const rows = this.database.db.prepare(`
      SELECT m.id FROM chat_messages m
      LEFT JOIN chat_message_reads r ON r.message_id = m.id
      WHERE m.owner_type = ? AND m.owner_id = ? AND ${visibleReply} AND r.message_id IS NULL
      ORDER BY m.created_at, m.rowid
    `).all(ownerType, ownerId) as Array<{ id: string }>;
    return { unreadMessageIds: rows.map((row) => row.id), unreadCount: rows.length };
  }

  markRead(ownerType: SessionOwnerType, ownerId: string, messageIds: unknown): ChatReadState {
    assertDomain(Array.isArray(messageIds) && messageIds.length <= 1000
      && messageIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200),
    "Provide up to 1000 message IDs", "invalid_message_ids");
    const insert = this.database.db.prepare(`
      INSERT OR IGNORE INTO chat_message_reads (message_id, read_at)
      SELECT m.id, ? FROM chat_messages m
      WHERE m.id = ? AND m.owner_type = ? AND m.owner_id = ? AND ${visibleReply}
    `);
    this.database.db.transaction(() => {
      const readAt = new Date().toISOString();
      for (const id of new Set(messageIds as string[])) insert.run(readAt, id, ownerType, ownerId);
    })();
    return this.unread(ownerType, ownerId);
  }
}
