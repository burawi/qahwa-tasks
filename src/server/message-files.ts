import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { assertDomain, DomainError } from "../domain/errors.js";
import type { ChatMessage, SessionOwnerType, TaskArtifact } from "../domain/types.js";
import type { AppDatabase } from "./database.js";

export const FILE_DELIVERY_INSTRUCTIONS = `When sharing a local deliverable, use Qahwa's existing in-chat preview and Download controls in both progress and final replies. Write a Markdown link [filename](/absolute/project/path/file.ext), or ![caption](/absolute/project/path/image.png) for an image. Wrap paths containing spaces in angle brackets. Qahwa automatically registers existing files from completed assistant messages; no review submission or task state change is needed. Keep deliverables inside the task's project root. In orchestrator chat use absolute paths inside a registered project root or the Qahwa host repository. Do not deliver sandbox:, bare filesystem paths, or file:// URLs as user-facing download links. Ordinary source-code references with line numbers remain navigation references. Do not claim a missing or out-of-scope file is downloadable. Text, images, audio, video and PDF use the existing previews; other supported documents use Download.`;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", log: "text/plain",
  ts: "text/plain", tsx: "text/plain", js: "text/plain", jsx: "text/plain", mjs: "text/plain", cjs: "text/plain", css: "text/plain",
  py: "text/plain", sh: "text/plain", sql: "text/plain", yaml: "text/plain", yml: "text/plain", xml: "text/plain", toml: "text/plain",
  html: "application/octet-stream", htm: "application/octet-stream", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", apk: "application/vnd.android.package-archive",
};

interface FileRow {
  id: string; owner_type: SessionOwnerType; owner_id: string; root: string; path: string;
  signature: string; size: number; media_type: string;
}

function signature(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

// Parse Markdown, rather than scanning arbitrary prose/code examples for paths.
export function deliveredFileLinks(body: string): string[] {
  const tree = fromMarkdown(body);
  const definitions = new Map<string, string>();
  const visit = (node: Nodes, callback: (node: Nodes) => void) => {
    callback(node);
    if ("children" in node) for (const child of node.children) visit(child, callback);
  };
  visit(tree, node => { if (node.type === "definition") definitions.set(node.identifier, node.url); });
  const links = new Set<string>();
  visit(tree, node => {
    const url = node.type === "link" || node.type === "image" ? node.url
      : node.type === "linkReference" || node.type === "imageReference" ? definitions.get(node.identifier) : undefined;
    if (url && links.size < 100) links.add(url);
  });
  return [...links];
}

export function localDeliveryPath(source: string): string | null {
  if (!source || source.length > 2_000 || source.startsWith("//") || /[?#\x00-\x1f]/.test(source)) return null;
  try {
    let path: string;
    if (/^file:\/\//i.test(source)) path = fileURLToPath(source);
    else if (/^sandbox:\//i.test(source)) path = decodeURIComponent(source.slice("sandbox:".length));
    else if (/^[a-z][a-z\d+.-]*:/i.test(source)) return null;
    else path = decodeURIComponent(source);
    // Do not turn source navigation or hidden/configuration files into deliveries.
    if (/[:?#\x00-\x1f]/.test(path) || path.startsWith("//") || (!isAbsolute(path) && path.split(/[\\/]/).some(part => (part.startsWith(".") && part !== "." && part !== "..") || part === "node_modules"))) return null;
    return TYPES[extname(path).slice(1).toLowerCase()] ? path : null;
  } catch { return null; }
}

/** Message-scoped registrations never rewrite chat history or create review outputs. */
export class MessageFiles {
  constructor(private readonly database: AppDatabase, private readonly hostRoot = process.cwd()) {}

  private roots(ownerType: SessionOwnerType, ownerId: string): string[] {
    const rows = ownerType === "task"
      ? this.database.db.prepare("SELECT p.root_directory AS root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").all(ownerId)
      : this.database.db.prepare("SELECT root_directory AS root FROM projects").all();
    const roots = (rows as Array<{ root: string }>).map(row => row.root);
    if (ownerType === "orchestrator") roots.push(this.hostRoot);
    return [...new Set(roots.flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } }))];
  }

  register(message: ChatMessage): void {
    if (message.role !== "assistant" || message.cancelledAt) return;
    // A message is inspected once, including rejected/missing candidates. A later
    // replacement must not silently become the deliverable in an older message.
    if (this.database.db.prepare("SELECT 1 FROM message_file_scans WHERE message_id=?").get(message.id)) return;
    const roots = this.roots(message.ownerType, message.ownerId);
    const cutoff = Date.parse(message.createdAt) + 1; // filesystem sub-millisecond precision
    this.database.db.transaction(() => {
      for (const source of deliveredFileLinks(message.body)) {
        const local = localDeliveryPath(source);
        if (!local) continue;
        try {
          // Relative orchestrator references resolve only from its actual cwd.
          const base = message.ownerType === "task" ? roots[0] : realpathSync(this.hostRoot);
          if (!base) continue;
          const candidate = resolve(base, local);
          const root = roots.filter(root => within(root, candidate)).sort((a, b) => b.length - a.length)[0];
          if (!root || !localDeliveryPath(relative(root, candidate))) continue;
          const path = realpathSync(candidate);
          if (!within(root, path) || !localDeliveryPath(relative(root, path)) || !Number.isFinite(cutoff)) continue;
          const stats = statSync(path, { bigint: true });
          if (!stats.isFile() || Number(stats.mtimeMs) >= cutoff || Number(stats.ctimeMs) >= cutoff) continue;
          const stamp = signature(stats);
          this.database.db.prepare(`INSERT OR IGNORE INTO message_files(id,owner_type,owner_id,root,path,signature,size,media_type)
            VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), message.ownerType, message.ownerId, root, path, stamp, Number(stats.size), TYPES[extname(local).slice(1).toLowerCase()]!);
          const file = this.database.db.prepare("SELECT id FROM message_files WHERE owner_type=? AND owner_id=? AND path=? AND signature=?")
            .get(message.ownerType, message.ownerId, path, stamp) as { id: string };
          this.database.db.prepare("INSERT OR IGNORE INTO message_file_links(message_id,source,file_id) VALUES (?,?,?)").run(message.id, source, file.id);
        } catch { /* Missing, inaccessible, or ambiguous files remain ordinary unavailable links. */ }
      }
      this.database.db.prepare("INSERT OR IGNORE INTO message_file_scans(message_id) VALUES (?)").run(message.id);
    })();
  }

  private current(row: FileRow): boolean {
    try {
      return this.roots(row.owner_type, row.owner_id).includes(row.root)
        && within(row.root, realpathSync(row.path))
        && signature(statSync(row.path, { bigint: true })) === row.signature;
    } catch { return false; }
  }

  decorate(message: ChatMessage): ChatMessage {
    this.register(message);
    const rows = this.database.db.prepare(`SELECT f.*,l.source FROM message_file_links l JOIN message_files f ON f.id=l.file_id
      WHERE l.message_id=? AND f.owner_type=? AND f.owner_id=? ORDER BY l.rowid`).all(message.id, message.ownerType, message.ownerId) as Array<FileRow & { source: string }>;
    if (!rows.length) return message;
    const files: TaskArtifact[] = rows.map(row => {
      const available = this.current(row);
      const kind = row.media_type.startsWith("image/") ? "image" : row.media_type.startsWith("video/") ? "video"
        : row.media_type.startsWith("audio/") ? "audio" : row.media_type === "application/pdf" ? "pdf"
          : row.media_type.startsWith("text/") || row.media_type === "application/json" ? "text" : "none";
      return { source: row.source, sourceType: "path", filename: basename(row.path), mediaType: row.media_type, size: row.size,
        previewKind: kind, availability: available ? "available" : "missing",
        previewUrl: available ? this.url(row) : null };
    });
    return { ...message, metadata: { ...message.metadata, files } };
  }

  private url(row: FileRow): string {
    return row.owner_type === "task" ? `/api/tasks/${encodeURIComponent(row.owner_id)}/files/${row.id}` : `/api/orchestrator/files/${row.id}`;
  }

  open(ownerType: SessionOwnerType, ownerId: string, fileId: string): { fd: number; filename: string; size: number; mediaType: string } {
    const row = this.database.db.prepare(`SELECT f.* FROM message_files f WHERE f.id=? AND f.owner_type=? AND f.owner_id=?
      AND EXISTS (SELECT 1 FROM message_file_links l JOIN chat_messages m ON m.id=l.message_id
        WHERE l.file_id=f.id AND m.owner_type=f.owner_type AND m.owner_id=f.owner_id AND m.cancelled_at IS NULL)`).get(fileId, ownerType, ownerId) as FileRow | undefined;
    assertDomain(row, "File not found in this chat", "message_file_not_found", 404);
    assertDomain(this.current(row), "File changed or is no longer available", "message_file_changed", 409);
    let fd: number | undefined;
    try {
      fd = openSync(row.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = fstatSync(fd, { bigint: true });
      assertDomain(stats.isFile() && signature(stats) === row.signature, "File changed or is no longer available", "message_file_changed", 409);
      return { fd, filename: basename(row.path), size: row.size, mediaType: row.media_type };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (error instanceof DomainError) throw error;
      throw new DomainError("File changed or is no longer available", "message_file_changed", 409);
    }
  }
}
