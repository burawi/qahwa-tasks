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
  commit_proposal_json TEXT,
  commit_approval_status TEXT,
  approved_commit_hash TEXT,
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

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('task','orchestrator')),
  owner_id TEXT NOT NULL,
  thread_id TEXT,
  active_turn_id TEXT,
  surface TEXT NOT NULL DEFAULT 'undecided' CHECK(surface IN ('undecided','chat','design')),
  run_state TEXT NOT NULL DEFAULT 'not_started' CHECK(run_state IN ('not_started','idle','running','waiting','failed','interrupted')),
  generation INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_type, owner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_thread ON agent_sessions(thread_id) WHERE thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('task','orchestrator')),
  owner_id TEXT NOT NULL,
  codex_item_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  body TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_item ON chat_messages(codex_item_id) WHERE codex_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_owner ON chat_messages(owner_type, owner_id, created_at);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('task','orchestrator')),
  owner_id TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  item_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_events_owner ON session_events(owner_type, owner_id, id);

CREATE TABLE IF NOT EXISTS pending_requests (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('task','orchestrator')),
  owner_id TEXT NOT NULL,
  rpc_request_id TEXT,
  request_type TEXT NOT NULL CHECK(request_type IN ('command','file_change','user_input','permissions','other')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','answered','expired')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_requests_owner ON pending_requests(owner_type, owner_id, status);

CREATE TABLE IF NOT EXISTS task_presence (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT 'Not started',
  tone TEXT NOT NULL DEFAULT 'neutral' CHECK(tone IN ('neutral','blue','green','orange','red')),
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS design_documents (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  document_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS design_versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  document_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_design_versions_task ON design_versions(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  capacity_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  device_id TEXT REFERENCES paired_devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paired_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_grants (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

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
    this.db.exec("DROP TABLE IF EXISTS notification_outbox");
    this.db.prepare("DELETE FROM app_settings WHERE key IN ('password_hash', 'setup_token')").run();
    this.db.prepare("DELETE FROM sessions WHERE device_id IS NULL").run();
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
    const outputColumns = new Set((this.db.prepare("PRAGMA table_info(task_outputs)").all() as Array<{ name: string }>).map((row) => row.name));
    if (outputColumns.has("preview_json")) this.db.exec("ALTER TABLE task_outputs DROP COLUMN preview_json");
    if (!outputColumns.has("commit_proposal_json")) this.db.exec("ALTER TABLE task_outputs ADD COLUMN commit_proposal_json TEXT");
    if (!outputColumns.has("commit_approval_status")) this.db.exec("ALTER TABLE task_outputs ADD COLUMN commit_approval_status TEXT");
    if (!outputColumns.has("approved_commit_hash")) this.db.exec("ALTER TABLE task_outputs ADD COLUMN approved_commit_hash TEXT");
    const sessionColumns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!sessionColumns.has("device_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN device_id TEXT REFERENCES paired_devices(id) ON DELETE CASCADE");
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
