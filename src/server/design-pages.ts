import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertDomain } from "../domain/errors.js";
import type { DesignDocument, DesignPage } from "../domain/types.js";

type PageRow = { id: string; name: string; document_json: string; revision: number; created_at: string; updated_at: string };
const page = (row: PageRow): DesignPage => ({ id: row.id, name: row.name, document: JSON.parse(row.document_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });

// Keep the legacy tables intact as migration evidence. They are never written by
// the page workflow. The marker makes reopening a database idempotent.
export function migrateDesignPages(db: Database.Database): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM app_settings WHERE key = 'design_pages_migrated'").get()) return;
    const current = db.prepare("SELECT * FROM design_documents").all() as Array<{ task_id: string; document_json: string; revision: number; updated_at: string }>;
    const insert = db.prepare("INSERT INTO design_pages (id, task_id, name, document_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const row of current) {
      const id = `canvas:${row.task_id}`;
      const document = JSON.parse(row.document_json) as DesignDocument;
      insert.run(id, row.task_id, document.artboard.name || "Page 1", row.document_json, row.revision, row.updated_at, row.updated_at);
      db.prepare("INSERT INTO design_page_selection (task_id, page_id) VALUES (?, ?)").run(row.task_id, id);
    }
    const versions = db.prepare("SELECT * FROM design_versions ORDER BY created_at, rowid").all() as Array<{ id: string; task_id: string; name: string; document_json: string; revision: number; created_at: string }>;
    for (const row of versions) {
      insert.run(row.id, row.task_id, row.name, row.document_json, row.revision, row.created_at, row.created_at);
      db.prepare("INSERT OR IGNORE INTO design_page_selection (task_id, page_id) VALUES (?, ?)").run(row.task_id, row.id);
    }
    const comments = db.prepare("SELECT id, task_id, metadata_json FROM comments WHERE metadata_json IS NOT NULL").all() as Array<{ id: string; task_id: string; metadata_json: string }>;
    for (const row of comments) {
      const metadata = JSON.parse(row.metadata_json);
      const anchor = metadata?.canvas;
      if (!anchor || anchor.pageId) continue;
      const id = anchor.versionId === "current" ? `canvas:${row.task_id}` : anchor.versionId;
      if (db.prepare("SELECT 1 FROM design_pages WHERE id = ? AND task_id = ?").get(id ?? null, row.task_id)) {
        // Preserve all original anchor fields and unrelated metadata.
        anchor.pageId = id;
        db.prepare("UPDATE comments SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), row.id);
      }
    }
    // Pending and in-flight requests from the legacy UI targeted the current
    // canvas. Capture that identity before users can switch to another page.
    for (const row of current) {
      db.prepare("UPDATE agent_sessions SET canvas_request_page_id = ? WHERE owner_type = 'task' AND owner_id = ?").run(`canvas:${row.task_id}`, row.task_id);
      db.prepare(`INSERT OR IGNORE INTO design_page_turns (turn_id, task_id, page_id)
        SELECT active_turn_id, owner_id, ? FROM agent_sessions WHERE owner_type = 'task' AND owner_id = ? AND active_turn_id IS NOT NULL`).run(`canvas:${row.task_id}`, row.task_id);
    }
    const pending = db.prepare(`SELECT m.id, m.owner_id, m.metadata_json FROM chat_messages m JOIN pending_messages p ON p.message_id = m.id WHERE m.owner_type = 'task'`).all() as Array<{ id: string; owner_id: string; metadata_json: string | null }>;
    for (const row of pending) {
      const metadata = JSON.parse(row.metadata_json || "{}");
      metadata.designPageId = selectedDesignPageId(db, row.owner_id);
      db.prepare("UPDATE chat_messages SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), row.id);
    }
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('design_pages_migrated', '1', ?)").run(new Date().toISOString());
  })();
}

export function designPages(db: Database.Database, taskId: string): DesignPage[] {
  return (db.prepare("SELECT * FROM design_pages WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as PageRow[]).map(page);
}

export function selectedDesignPageId(db: Database.Database, taskId: string): string | null {
  return (db.prepare("SELECT page_id FROM design_page_selection WHERE task_id = ?").get(taskId) as { page_id: string } | undefined)?.page_id ?? null;
}

export function requireDesignPage(db: Database.Database, taskId: string, pageId: unknown): DesignPage {
  assertDomain(typeof pageId === "string", "Canvas page is required", "invalid_design_page");
  const row = db.prepare("SELECT * FROM design_pages WHERE task_id = ? AND id = ?").get(taskId, pageId) as PageRow | undefined;
  assertDomain(row, "Canvas page not found", "design_page_not_found", 404);
  return page(row);
}

export function designPageName(value: unknown): string {
  assertDomain(typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80, "Page name must contain 1–80 characters", "invalid_page_name");
  return value.trim();
}

export function selectDesignPage(db: Database.Database, taskId: string, pageId: unknown): void {
  const target = requireDesignPage(db, taskId, pageId);
  db.prepare("INSERT INTO design_page_selection (task_id, page_id) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET page_id = excluded.page_id").run(taskId, target.id);
}

export function insertDesignPage(db: Database.Database, taskId: string, name: string, document: DesignDocument): string {
  const id = randomUUID(), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO design_pages (id, task_id, name, document_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(id, taskId, name, JSON.stringify(document), timestamp, timestamp);
  return id;
}
