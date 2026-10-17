import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  prefix TEXT NOT NULL COLLATE NOCASE UNIQUE,
  root_directory TEXT NOT NULL,
  next_task_number INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description_json TEXT NOT NULL,
  description_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('backlog','todo','in_progress','in_review','closed')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed','cancelled')),
  rank REAL NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_rank ON tasks(status, rank, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS task_relationships (
  task_low_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_high_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('user','codex','system')),
  PRIMARY KEY (task_low_id, task_high_id),
  CHECK (task_low_id < task_high_id)
);

CREATE INDEX IF NOT EXISTS idx_task_relationships_high ON task_relationships(task_high_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK(author IN ('user','codex','system')),
  kind TEXT NOT NULL DEFAULT 'comment' CHECK(kind IN ('comment','handoff')),
  body_json TEXT NOT NULL,
  plain_text TEXT NOT NULL,
  requires_response INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_outputs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '[]',
  commit_hash TEXT,
  limitations_json TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  run_id TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  source_comment_id TEXT UNIQUE REFERENCES comments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_outputs_task ON task_outputs(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  description_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_task ON activity(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
ON notification_outbox(status, next_attempt_at);
`;

export class AppDatabase {
  readonly db: Database.Database;
  readonly path: string;
  readonly dataDir: string;

  constructor(config: Config, explicitPath?: string) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = config.dataDir;
    this.path = explicitPath ?? join(config.dataDir, "qahwa-tasks.sqlite");
    this.db = new Database(this.path);
    chmodSync(this.path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((row) => row.name));
    const additions = [
      ["logo_filename", "TEXT"],
      ["logo_mime_type", "TEXT"],
      ["logo_size", "INTEGER"],
      ["logo_updated_at", "TEXT"],
    ] as const;
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
    }
    this.migrateHandoffComments();
  }

  private migrateHandoffComments(): void {
    const rows = this.db.prepare(`
      SELECT id, task_id, plain_text, metadata_json, created_at FROM comments
      WHERE kind = 'handoff' AND id NOT IN (
        SELECT source_comment_id FROM task_outputs WHERE source_comment_id IS NOT NULL
      ) ORDER BY created_at
    `).all() as Array<{
      id: string; task_id: string; plain_text: string; metadata_json: string | null; created_at: string;
    }>;
    const insert = this.db.prepare(`
      INSERT INTO task_outputs
      (id, task_id, summary, validation_json, commit_hash, limitations_json, session_id, run_id, artifacts_json, source_comment_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        const metadata = this.parseHandoffMetadata(row.metadata_json);
        insert.run(
          row.id, row.task_id, this.metadataString(metadata.summary) ?? row.plain_text,
          JSON.stringify(this.metadataList(metadata.validation)), this.metadataString(metadata.commit),
          JSON.stringify(this.metadataList(metadata.limitations)), this.metadataString(metadata.sessionId),
          this.metadataString(metadata.runId), JSON.stringify(this.metadataList(metadata.artifacts)), row.id, row.created_at,
        );
      }
    });
    migrate();
  }

  private parseHandoffMetadata(value: string | null): Record<string, unknown> {
    if (!value) return {};
    try { return JSON.parse(value) as Record<string, unknown>; }
    catch { return {}; }
  }

  private metadataString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
  }

  private metadataList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  setting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();
  }
}
