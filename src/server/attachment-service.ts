import { mkdirSync, openSync, closeSync, appendFileSync, statSync, existsSync, rmSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, assertDomain } from "../domain/errors.js";
import type { ChatAttachment, ChatMessage, SessionOwnerType } from "../domain/types.js";
import type { AppDatabase } from "./database.js";

export const ATTACHMENT_LIMITS = {
  chunkBytes: 256 * 1024,
  fileBytes: 100 * 1024 * 1024,
  messageBytes: 250 * 1024 * 1024,
  abandonedMs: 60 * 60 * 1000,
  completedMs: 30 * 24 * 60 * 60 * 1000,
} as const;
// Previous releases stored uploads here. Keep it readable until their existing
// retention periods expire, but never put new uploads on the shared tmpfs.
export const ATTACHMENT_ROOT = "/tmp/qahwa-tasks-attachments";

interface AttachmentRow {
  id: string;
  owner_type: SessionOwnerType;
  owner_id: string;
  device_id: string;
  message_id: string | null;
  filename: string;
  media_type: string;
  declared_size: number;
  received_size: number;
  next_chunk: number;
  status: "uploading" | "complete" | "expired";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at: string;
}

export interface PreparedAttachment extends ChatAttachment { path: string }

const now = () => new Date().toISOString();

function safeFilename(value: string): string {
  const filename = value.trim();
  assertDomain(filename.length > 0 && Buffer.byteLength(filename) <= 255, "Filename must be 1–255 bytes", "invalid_filename");
  assertDomain(filename !== "." && filename !== ".." && filename === basename(filename) && !/[\\/\u0000-\u001f\u007f]/.test(filename), "Filename contains unsafe characters", "invalid_filename");
  return filename;
}

export class AttachmentService {
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly database: AppDatabase, readonly root = join(database.dataDir, "attachments"), private readonly legacyRoot = ATTACHMENT_ROOT) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    this.cleanupStale();
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 15 * 60_000);
    this.cleanupTimer.unref();
  }

  initiate(ownerType: SessionOwnerType, ownerId: string, deviceId: string, input: { filename?: unknown; mediaType?: unknown; size?: unknown }): ChatAttachment & { chunkBytes: number } {
    this.cleanupStale();
    const filename = safeFilename(typeof input.filename === "string" ? input.filename : "");
    const size = Number(input.size);
    assertDomain(Number.isSafeInteger(size) && size >= 0 && size <= ATTACHMENT_LIMITS.fileBytes, "Files may be at most 100 MiB", "invalid_attachment_size");
    const mediaType = typeof input.mediaType === "string" && input.mediaType.trim() ? input.mediaType.trim().slice(0, 255) : "application/octet-stream";
    const id = randomUUID();
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ATTACHMENT_LIMITS.abandonedMs).toISOString();
    mkdirSync(this.directory(id), { mode: 0o700 });
    this.database.db.prepare(`INSERT INTO attachment_uploads
      (id, owner_type, owner_id, device_id, filename, media_type, declared_size, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerType, ownerId, deviceId, filename, mediaType, size, timestamp, timestamp, expiresAt);
    return { id, filename, mediaType, size, status: "available", previewUrl: this.previewUrl(ownerType, ownerId, id), chunkBytes: ATTACHMENT_LIMITS.chunkBytes };
  }

  appendChunk(id: string, deviceId: string, chunkIndex: number, chunk: Buffer): { receivedSize: number; size: number } {
    const row = this.ownedUpload(id, deviceId);
    assertDomain(row.status === "uploading", "Upload is no longer accepting chunks", "upload_not_active", 409);
    assertDomain(Number.isSafeInteger(chunkIndex) && chunkIndex === row.next_chunk, "Upload chunk is missing or out of order", "invalid_chunk_order", 409);
    assertDomain(chunk.length > 0 && chunk.length <= ATTACHMENT_LIMITS.chunkBytes, "Upload chunk must be 1–256 KiB", "invalid_chunk_size");
    assertDomain(row.received_size + chunk.length <= row.declared_size, "Upload exceeds its declared size", "attachment_size_mismatch");
    const path = this.filePath(id);
    if (chunkIndex === 0) {
      const descriptor = openSync(path, "wx", 0o600);
      closeSync(descriptor);
    }
    appendFileSync(path, chunk);
    const received = row.received_size + chunk.length;
    this.database.db.prepare("UPDATE attachment_uploads SET received_size = ?, next_chunk = ?, updated_at = ? WHERE id = ?")
      .run(received, chunkIndex + 1, now(), id);
    return { receivedSize: received, size: row.declared_size };
  }

  complete(id: string, deviceId: string): ChatAttachment {
    const row = this.ownedUpload(id, deviceId);
    assertDomain(row.status === "uploading", "Upload is no longer active", "upload_not_active", 409);
    const path = this.filePath(id);
    if (row.declared_size === 0 && !existsSync(path)) writeFileSync(path, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    const actualSize = existsSync(path) ? statSync(path).size : -1;
    assertDomain(row.received_size === row.declared_size && actualSize === row.declared_size, "Uploaded data does not match the declared size", "attachment_size_mismatch");
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ATTACHMENT_LIMITS.completedMs).toISOString();
    this.database.db.prepare("UPDATE attachment_uploads SET status = 'complete', completed_at = ?, updated_at = ?, expires_at = ? WHERE id = ?")
      .run(timestamp, timestamp, expiresAt, id);
    return this.publicAttachment({ ...row, status: "complete", completed_at: timestamp, updated_at: timestamp, expires_at: expiresAt });
  }

  remove(id: string, deviceId: string): void {
    const row = this.ownedUpload(id, deviceId);
    assertDomain(!row.message_id, "Sent attachments cannot be removed from history", "attachment_in_use", 409);
    this.removeFiles(id);
    this.database.db.prepare("DELETE FROM attachment_uploads WHERE id = ?").run(id);
  }

  prepareForMessage(ownerType: SessionOwnerType, ownerId: string, deviceId: string, ids: string[]): PreparedAttachment[] {
    const uniqueIds = [...new Set(ids)];
    assertDomain(uniqueIds.length === ids.length, "Attachment identifiers must be unique", "invalid_attachments");
    const rows = uniqueIds.map((id) => this.database.db.prepare("SELECT * FROM attachment_uploads WHERE id = ?").get(id) as AttachmentRow | undefined);
    assertDomain(rows.every((row): row is AttachmentRow => Boolean(row && row.owner_type === ownerType && row.owner_id === ownerId && row.device_id === deviceId)), "Attachment does not belong to this chat session", "attachment_forbidden", 403);
    assertDomain(rows.every((row) => row.status === "complete" && !row.message_id && existsSync(this.filePath(row.id))), "Attachment is incomplete or expired", "attachment_unavailable", 409);
    const total = rows.reduce((sum, row) => sum + row.declared_size, 0);
    assertDomain(total <= ATTACHMENT_LIMITS.messageBytes, "Attachments may total at most 250 MiB per message", "attachments_too_large");
    return rows.map((row) => ({ ...this.publicAttachment(row), path: this.filePath(row.id) }));
  }

  attachToMessage(ids: string[], messageId: string): void {
    const update = this.database.db.prepare("UPDATE attachment_uploads SET message_id = ?, updated_at = ? WHERE id = ? AND message_id IS NULL");
    const transaction = this.database.db.transaction(() => ids.forEach((id) => update.run(messageId, now(), id)));
    transaction();
  }

  // Accepted messages must survive temporary-directory cleanup and long waits.
  retainForPendingMessage(ids: string[]): void {
    for (const id of ids) {
      const destination = this.durableDirectory(id);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      if (this.filePath(id) !== join(destination, "data")) copyFileSync(this.filePath(id), join(destination, "data"));
      chmodSync(join(destination, "data"), 0o600);
    }
  }

  forSavedMessage(message: ChatMessage): PreparedAttachment[] {
    return (message.metadata?.attachments ?? []).map((attachment) => {
      const { path } = this.resolveDownload(message.ownerType, message.ownerId, attachment.id);
      return { ...attachment, path };
    });
  }

  forTaskCreation(taskId: string): PreparedAttachment[] {
    const rows = this.database.db.prepare(`SELECT a.id FROM task_creation_attachments t
      JOIN attachment_uploads a ON a.id = t.attachment_id WHERE t.task_id = ? ORDER BY a.created_at, a.id`)
      .all(taskId) as Array<{ id: string }>;
    return rows.map(({ id }) => {
      const { path, attachment } = this.resolveDownload("task", taskId, id);
      return { ...attachment, path };
    });
  }

  bindToCreatedTask(ids: string[], taskId: string, messageId: string): ChatAttachment[] {
    const update = this.database.db.prepare("UPDATE attachment_uploads SET owner_id = ?, message_id = ?, updated_at = ? WHERE id = ?");
    const link = this.database.db.prepare("INSERT INTO task_creation_attachments (attachment_id, task_id) VALUES (?, ?)");
    for (const id of ids) {
      update.run(taskId, messageId, now(), id);
      link.run(id, taskId);
    }
    return ids.map(id => this.resolveDownload("task", taskId, id).attachment);
  }

  removeDraftUploads(draftId: string, deviceId: string): void {
    const rows = this.database.db.prepare("SELECT id FROM attachment_uploads WHERE owner_type = 'task' AND owner_id = ? AND device_id = ?")
      .all(`draft:${draftId}`, deviceId) as Array<{ id: string }>;
    for (const { id } of rows) this.remove(id, deviceId);
  }

  markMessageStarted(messageId: string): void {
    this.database.db.prepare("UPDATE attachment_uploads SET expires_at = ? WHERE message_id = ?")
      .run(new Date(Date.now() + ATTACHMENT_LIMITS.completedMs).toISOString(), messageId);
  }

  resolveDownload(ownerType: SessionOwnerType, ownerId: string, id: string): { path: string; attachment: ChatAttachment } {
    const row = this.database.db.prepare("SELECT * FROM attachment_uploads WHERE id = ? AND owner_type = ? AND owner_id = ?").get(id, ownerType, ownerId) as AttachmentRow | undefined;
    assertDomain(row?.status === "complete" && existsSync(this.filePath(id)), "Attachment has expired", "attachment_expired", 410);
    return { path: this.filePath(id), attachment: this.publicAttachment(row) };
  }

  decorateMessage(message: ChatMessage): ChatMessage {
    const stored = message.metadata?.attachments;
    if (!Array.isArray(stored)) return message;
    const attachments = stored.map((item) => {
      const row = this.database.db.prepare("SELECT * FROM attachment_uploads WHERE id = ?").get(item.id) as AttachmentRow | undefined;
      return { ...item, status: row?.status === "complete" && existsSync(this.filePath(item.id)) ? "available" as const : "expired" as const };
    });
    return { ...message, metadata: { ...message.metadata, attachments } };
  }

  cleanupStale(at = Date.now()): number {
    const rows = this.database.db.prepare(`SELECT * FROM attachment_uploads a WHERE status != 'expired' AND expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM pending_messages p WHERE p.message_id = a.message_id)
      AND NOT EXISTS (SELECT 1 FROM message_schedules ms JOIN chat_messages m ON m.id=ms.message_id
        WHERE ms.state IN ('pending','reserved') AND json_extract(m.metadata_json,'$.scheduledFromMessageId')=a.message_id)
      AND NOT EXISTS (SELECT 1 FROM task_creation_attachments t WHERE t.attachment_id = a.id)`)
      .all(new Date(at).toISOString()) as AttachmentRow[];
    const expire = this.database.db.prepare("UPDATE attachment_uploads SET status = 'expired', updated_at = ? WHERE id = ?");
    const transaction = this.database.db.transaction(() => {
      for (const row of rows) {
        this.removeFiles(row.id);
        expire.run(now(), row.id);
      }
    });
    transaction();
    return rows.length;
  }

  close(): void { clearInterval(this.cleanupTimer); }

  private ownedUpload(id: string, deviceId: string): AttachmentRow {
    const row = this.database.db.prepare("SELECT * FROM attachment_uploads WHERE id = ? AND device_id = ?").get(id, deviceId) as AttachmentRow | undefined;
    if (!row) throw new DomainError("Attachment upload not found", "attachment_not_found", 404);
    return row;
  }

  private publicAttachment(row: AttachmentRow): ChatAttachment {
    return {
      id: row.id,
      filename: row.filename,
      mediaType: row.media_type,
      size: row.declared_size,
      status: row.status === "complete" && existsSync(this.filePath(row.id)) ? "available" : "expired",
      previewUrl: this.previewUrl(row.owner_type, row.owner_id, row.id),
    };
  }

  private previewUrl(ownerType: SessionOwnerType, ownerId: string, id: string): string {
    return ownerType === "task"
      ? `/api/tasks/${encodeURIComponent(ownerId)}/attachments/${encodeURIComponent(id)}`
      : `/api/orchestrator/attachments/${encodeURIComponent(id)}`;
  }

  private directory(id: string): string {
    assertDomain(/^[0-9a-f-]{36}$/.test(id), "Invalid attachment identifier", "attachment_not_found", 404);
    return join(this.root, id);
  }
  private durableDirectory(id: string): string {
    this.directory(id); // Validate identifiers before constructing either path.
    return join(this.database.dataDir, "pending-attachments", id);
  }
  private filePath(id: string): string {
    const durable = join(this.durableDirectory(id), "data");
    if (existsSync(durable)) return durable;
    const current = join(this.directory(id), "data");
    if (existsSync(current)) return current;
    const legacy = join(this.legacyRoot, id, "data");
    return existsSync(legacy) ? legacy : current;
  }
  private removeFiles(id: string): void {
    for (const directory of [this.directory(id), this.durableDirectory(id), join(this.legacyRoot, id)]) {
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    }
  }
}
