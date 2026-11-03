import type Database from "better-sqlite3";
import { assertDomain } from "../domain/errors.js";
import type { MessagePageQuery, SessionOwnerType } from "../domain/types.js";

export const MESSAGE_PAGE_SIZE = 50;
export const VISIBLE_MESSAGE = "json_type(m.metadata_json, '$.queueScheduling') IS NOT 'true'";

interface Boundary { createdAt: string; row: number }
interface OrderedRow { history_row: number; created_at: string }

/** Cursors carry an immutable ordering key, so edits/deletions cannot shift a page. */
function boundary(value: unknown, ownerType: SessionOwnerType, ownerId: string): Boundary | null {
  if (value === undefined) return null;
  assertDomain(typeof value === "string" && value.length <= 2048, "Invalid message history cursor", "invalid_history_cursor");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { /* validated below */ }
  assertDomain(Array.isArray(parsed) && parsed.length === 4 && parsed[0] === ownerType && parsed[1] === ownerId
    && typeof parsed[2] === "string" && parsed[2].length > 0 && parsed[2].length <= 100
    && Number.isSafeInteger(parsed[3]) && parsed[3] > 0, "Invalid message history cursor", "invalid_history_cursor");
  return { createdAt: parsed[2] as string, row: parsed[3] as number };
}

export function readMessagePage<T extends OrderedRow>(db: Database.Database, ownerType: SessionOwnerType, ownerId: string, query: MessagePageQuery = {}) {
  const before = boundary(query.before, ownerType, ownerId);
  const through = boundary(query.through, ownerType, ownerId);
  const filters = ["m.owner_type = ?", "m.owner_id = ?", VISIBLE_MESSAGE];
  const values: (string | number)[] = [ownerType, ownerId];
  if (before) { filters.push("(m.created_at, m.rowid) < (?, ?)"); values.push(before.createdAt, before.row); }
  if (through) { filters.push("(m.created_at, m.rowid) >= (?, ?)"); values.push(through.createdAt, through.row); }
  // The look-ahead row is never decorated or returned. No OFFSET or full-history read.
  const rows = db.prepare(`SELECT m.*, m.rowid AS history_row,
    EXISTS(SELECT 1 FROM pending_messages p WHERE p.message_id = m.id) AS pending
    FROM chat_messages m WHERE ${filters.join(" AND ")}
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`).all(...values, MESSAGE_PAGE_SIZE + 1) as T[];
  const hasMore = rows.length > MESSAGE_PAGE_SIZE;
  rows.splice(MESSAGE_PAGE_SIZE);
  rows.reverse();
  const oldest = rows[0];
  const oldestCursor = oldest ? Buffer.from(JSON.stringify([ownerType, ownerId, oldest.created_at, oldest.history_row])).toString("base64url") : null;
  const hasOlder = oldest && through ? Boolean(db.prepare(`SELECT 1 FROM chat_messages m
    WHERE m.owner_type = ? AND m.owner_id = ? AND ${VISIBLE_MESSAGE}
      AND (m.created_at, m.rowid) < (?, ?) LIMIT 1`).get(ownerType, ownerId, oldest.created_at, oldest.history_row)) : hasMore;
  return { rows, oldestCursor, hasOlder: Boolean(hasOlder) };
}
