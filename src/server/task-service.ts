import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { assertDomain, DomainError } from "../domain/errors.js";
import { TaskSchedules } from "./task-schedules.js";
import { MessageSchedules } from "./message-schedules.js";
import { requireDesignPage } from "./design-pages.js";
import { MAX_PROJECT_LOGO_BYTES, PROJECT_LOGO_SIZE_ERROR } from "../domain/project-logo.js";
import {
  documentFromSections,
  emptyDocument,
  plainTextFromDocument,
  type Actor,
  type ArtifactReference,
  type CommentKind,
  type CommitApproval,
  type HandoffInput,
  type Project,
  type ProjectLogo,
  type RelatedTask,
  type RichTextDocument,
  type TaskComment,
  type TaskDetail,
  type TaskOutcome,
  type TaskOutput,
  type TaskArtifact,
  type TaskStatus,
  type TaskSummary,
  type SessionRunState,
  type SessionSurface,
  type TaskTone,
} from "../domain/types.js";
import type { AppDatabase } from "./database.js";
import { ReviewedCommitService, type StoredCommitProposal } from "./reviewed-commit.js";
import { detectUploadedImage } from "./image-upload.js";
import { fallbackTaskTitle } from "../domain/task-title.js";
import { ATTACHMENT_LIMITS } from "./attachment-service.js";

interface ProjectRow {
  id: string; name: string; prefix: string; root_directory: string; archived_at: string | null;
  logo_filename: string | null; logo_mime_type: ProjectLogo["mimeType"] | null; logo_size: number | null; logo_updated_at: string | null;
  task_count: number; created_at: string; updated_at: string;
}

interface TaskRow {
  session_kind: "codex" | "terminal";
  pinned_at: string | null;
  idle_notifications_enabled: number;
  id: string; human_id: string; project_id: string; project_name: string; project_prefix: string;
  project_logo_mime_type: ProjectLogo["mimeType"] | null; project_logo_size: number | null; project_logo_updated_at: string | null;
  root_directory: string; title: string; description_json: string; description_text: string; status: TaskStatus; outcome: TaskOutcome;
  rank: number; unresolved_comment_count: number; version: number; created_at: string; updated_at: string;
  smart_message: string; tone: TaskTone; session_state: SessionRunState; surface: SessionSurface;
  last_activity_at: string | null;
  conversation_activity_at?: string;
  latest_message_body?: string | null;
  latest_message_role?: "user" | "assistant";
  latest_message_at?: string;
  conversation_unread_count?: number;
}

interface CommentRow {
  id: string; task_id: string; parent_id: string | null; author: Actor; kind: CommentKind; body_json: string;
  plain_text: string; requires_response: number; resolved_at: string | null; metadata_json: string | null;
  created_at: string; updated_at: string;
}

interface OutputRow {
  id: string; task_id: string; summary: string; validation_json: string; commit_hash: string | null;
  limitations_json: string; session_id: string | null; run_id: string | null; artifacts_json: string;
  commit_proposal_json: string | null; commit_approval_status: "pending" | "processing" | "committed" | null;
  approved_commit_hash: string | null;
  source_comment_id: string | null; created_at: string;
}

export interface CreateTaskInput {
  projectId: string;
  title?: string;
  description?: RichTextDocument;
  sections?: { goal?: string; details?: string | string[]; doneWhen?: string[] };
  status?: "backlog" | "todo";
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo", "closed"],
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "closed"],
  in_review: ["in_progress", "closed"],
  closed: [],
};
const TASK_LIST_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "closed"];

function now(): string {
  return new Date().toISOString();
}

function parseDocument(value: string): RichTextDocument {
  return JSON.parse(value) as RichTextDocument;
}

function validateDocument(document: RichTextDocument): RichTextDocument {
  assertDomain(document?.type === "doc", "Content must be a rich-text document", "invalid_document");
  assertDomain(JSON.stringify(document).length <= 100_000, "Content is too long", "content_too_long");
  return document;
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id, name: row.name, prefix: row.prefix, rootDirectory: row.root_directory, archivedAt: row.archived_at,
    logo: logoFromValues(row.id, row.logo_mime_type, row.logo_size, row.logo_updated_at),
    taskCount: Number(row.task_count), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function taskFromRow(row: TaskRow): TaskSummary {
  return {
    sessionKind: row.session_kind,
    id: row.id, humanId: row.human_id, projectId: row.project_id, projectName: row.project_name,
    projectPrefix: row.project_prefix, title: row.title, status: row.status, outcome: row.outcome,
    projectLogo: logoFromValues(row.project_id, row.project_logo_mime_type, row.project_logo_size, row.project_logo_updated_at),
    rank: row.rank, unresolvedCommentCount: Number(row.unresolved_comment_count), version: row.version,
    smartMessage: row.smart_message, tone: row.tone, sessionState: row.session_state, surface: row.surface,
    lastActivityAt: row.last_activity_at,
    pinnedAt: row.pinned_at,
    ...(row.conversation_activity_at === undefined ? {} : { conversation: {
      ...(row.description_text ? { descriptionText: row.description_text } : {}),
      activityAt: row.conversation_activity_at,
      latestMessage: row.latest_message_body == null ? null : {
        preview: messagePreview(row.latest_message_body), role: row.latest_message_role!, createdAt: row.latest_message_at!,
      },
      unreadCount: Number(row.conversation_unread_count),
    } }),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function messagePreview(body: string): string {
  return body.replace(/<qahwa-design>[\s\S]*?<\/qahwa-design>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_#~]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 240) || "Attachment or canvas";
}

function logoFromValues(
  projectId: string,
  mimeType: ProjectLogo["mimeType"] | null,
  size: number | null,
  updatedAt: string | null,
): ProjectLogo | null {
  if (!mimeType || size === null || !updatedAt) return null;
  return { mimeType, size, updatedAt, url: `/api/projects/${encodeURIComponent(projectId)}/logo?v=${encodeURIComponent(updatedAt)}` };
}

export { MAX_PROJECT_LOGO_BYTES } from "../domain/project-logo.js";
export const MAX_ARTIFACT_PREVIEW_BYTES = 50 * 1024 * 1024;

const ARTIFACT_MEDIA_TYPES: Record<string, { mediaType: string; kind: TaskArtifact["previewKind"] }> = {
  ".avif": { mediaType: "image/avif", kind: "image" },
  ".gif": { mediaType: "image/gif", kind: "image" },
  ".jpeg": { mediaType: "image/jpeg", kind: "image" },
  ".jpg": { mediaType: "image/jpeg", kind: "image" },
  ".png": { mediaType: "image/png", kind: "image" },
  ".webp": { mediaType: "image/webp", kind: "image" },
  ".mp4": { mediaType: "video/mp4", kind: "video" },
  ".webm": { mediaType: "video/webm", kind: "video" },
  ".mp3": { mediaType: "audio/mpeg", kind: "audio" },
  ".wav": { mediaType: "audio/wav", kind: "audio" },
  ".ogg": { mediaType: "audio/ogg", kind: "audio" },
  ".m4a": { mediaType: "audio/mp4", kind: "audio" },
  ".flac": { mediaType: "audio/flac", kind: "audio" },
  ".opus": { mediaType: "audio/ogg", kind: "audio" },
  ".pdf": { mediaType: "application/pdf", kind: "pdf" },
};

export class TaskService {
  private readonly reviewedCommits = new ReviewedCommitService();

  constructor(private readonly database: AppDatabase) {}

  listProjects(includeArchived = false): Project[] {
    const rows = this.database.db.prepare(`
      SELECT p.*, COUNT(t.id) AS task_count FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
      ${includeArchived ? "" : "WHERE p.archived_at IS NULL"}
      GROUP BY p.id ORDER BY p.archived_at IS NOT NULL, p.name COLLATE NOCASE
    `).all() as ProjectRow[];
    return rows.map(projectFromRow);
  }

  createProject(input: { name: string; prefix?: string; rootDirectory: string }, actor: Actor): Project {
    const name = input.name.trim();
    const prefix = (input.prefix?.trim() || this.suggestPrefix(name)).toUpperCase();
    const rootDirectory = this.validateRoot(input.rootDirectory);
    assertDomain(name.length >= 1 && name.length <= 80, "Project name must be 1–80 characters", "invalid_project_name");
    assertDomain(/^[A-Z0-9]{2,6}$/.test(prefix), "Prefix must be 2–6 letters or numbers", "invalid_project_prefix");
    const id = randomUUID();
    const timestamp = now();
    try {
      this.database.db.prepare(`
        INSERT INTO projects (id, name, prefix, root_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, name, prefix, rootDirectory, timestamp, timestamp);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new DomainError("Project name or prefix already exists", "project_conflict", 409);
      throw error;
    }
    this.activity({ projectId: id, actor, eventType: "project.created", details: { name, prefix, rootDirectory } });
    return this.getProject(id);
  }

  updateProject(id: string, input: { name?: string; prefix?: string; rootDirectory?: string }, actor: Actor): Project {
    const project = this.getProject(id);
    const name = input.name?.trim() ?? project.name;
    const rootDirectory = input.rootDirectory ? this.validateRoot(input.rootDirectory) : project.rootDirectory;
    let prefix = input.prefix?.trim().toUpperCase() ?? project.prefix;
    if (input.prefix && project.taskCount > 0 && prefix !== project.prefix) {
      throw new DomainError("Project prefix is locked after its first task", "prefix_locked", 409);
    }
    assertDomain(name.length >= 1 && name.length <= 80, "Project name must be 1–80 characters", "invalid_project_name");
    assertDomain(/^[A-Z0-9]{2,6}$/.test(prefix), "Prefix must be 2–6 letters or numbers", "invalid_project_prefix");
    this.database.db.prepare("UPDATE projects SET name = ?, prefix = ?, root_directory = ?, updated_at = ? WHERE id = ?")
      .run(name, prefix, rootDirectory, now(), id);
    this.activity({ projectId: id, actor, eventType: "project.updated", details: { name, prefix, rootDirectory } });
    return this.getProject(id);
  }

  archiveProject(id: string, archived: boolean, actor: Actor): Project {
    this.getProject(id);
    this.database.db.prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? now() : null, now(), id);
    this.activity({ projectId: id, actor, eventType: archived ? "project.archived" : "project.restored" });
    return this.getProject(id);
  }

  deleteProject(id: string, actor: Actor): void {
    const project = this.getProject(id);
    assertDomain(project.taskCount === 0, "Only projects without tasks can be deleted", "project_has_tasks", 409);
    this.activity({ projectId: id, actor, eventType: "project.deleted", details: { name: project.name } });
    const filename = this.logoFilename(id);
    this.database.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    this.removeLogoFile(filename);
  }

  uploadProjectLogo(id: string, bytes: Buffer, declaredMimeType: string, actor: Actor): Project {
    this.getProject(id);
    assertDomain(bytes.length > 0, "Logo file is empty", "empty_project_logo");
    assertDomain(bytes.length <= MAX_PROJECT_LOGO_BYTES, PROJECT_LOGO_SIZE_ERROR, "project_logo_too_large", 413);
    const detected = detectUploadedImage(bytes);
    assertDomain(detected !== null, "Logo must be a PNG, JPEG, or WebP image", "invalid_project_logo_type");
    assertDomain(declaredMimeType.toLowerCase() === detected.mimeType, "Logo content does not match its file type", "project_logo_type_mismatch");
    const directory = this.logoDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = `${id}-${randomUUID()}.${detected.extension}`;
    const temporary = join(directory, `.${filename}.tmp`);
    const destination = join(directory, filename);
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    const previous = this.logoFilename(id);
    try {
      renameSync(temporary, destination);
      const timestamp = now();
      this.database.db.prepare(`
        UPDATE projects SET logo_filename = ?, logo_mime_type = ?, logo_size = ?, logo_updated_at = ?, updated_at = ? WHERE id = ?
      `).run(filename, detected.mimeType, bytes.length, timestamp, timestamp, id);
    } catch (error) {
      this.removeLogoFile(filename);
      this.removeLogoFile(basename(temporary));
      throw error;
    }
    this.removeLogoFile(previous);
    this.activity({ projectId: id, actor, eventType: "project.logo_updated", details: { mimeType: detected.mimeType, size: bytes.length } });
    return this.getProject(id);
  }

  removeProjectLogo(id: string, actor: Actor): Project {
    this.getProject(id);
    const filename = this.logoFilename(id);
    this.database.db.prepare(`
      UPDATE projects SET logo_filename = NULL, logo_mime_type = NULL, logo_size = NULL, logo_updated_at = NULL, updated_at = ? WHERE id = ?
    `).run(now(), id);
    this.removeLogoFile(filename);
    this.activity({ projectId: id, actor, eventType: "project.logo_removed" });
    return this.getProject(id);
  }

  projectLogoFile(id: string): { path: string; mimeType: ProjectLogo["mimeType"] } {
    const row = this.database.db.prepare("SELECT logo_filename, logo_mime_type FROM projects WHERE id = ?").get(id) as
      | { logo_filename: string | null; logo_mime_type: ProjectLogo["mimeType"] | null }
      | undefined;
    assertDomain(row, "Project not found", "project_not_found", 404);
    assertDomain(row.logo_filename && row.logo_mime_type, "Project logo not found", "project_logo_not_found", 404);
    return { path: this.safeLogoPath(row.logo_filename), mimeType: row.logo_mime_type };
  }

  createTask(input: CreateTaskInput, actor: Actor): TaskDetail {
    const description = validateDocument(input.description ?? this.descriptionFromSections(input.sections));
    assertDomain(input.title === undefined || typeof input.title === "string", "Title must be text", "invalid_title");
    const title = input.title?.trim() ?? fallbackTaskTitle(plainTextFromDocument(description));
    assertDomain(title.length >= 1 && title.length <= 200, "Title must be 1–200 characters", "invalid_title");
    const titleSource = input.title === undefined ? "fallback" : "manual";
    const status = input.status ?? "backlog";
    const create = this.database.db.transaction(() => {
      const project = this.database.db.prepare("SELECT * FROM projects WHERE id = ? AND archived_at IS NULL").get(input.projectId) as
        | (ProjectRow & { next_task_number: number })
        | undefined;
      assertDomain(project, "Active project not found", "project_not_found", 404);
      const id = randomUUID();
      const humanId = `${project.prefix}-${String(project.next_task_number).padStart(4, "0")}`;
      const rank = this.nextRank(status);
      const timestamp = now();
      this.database.db.prepare(`
        INSERT INTO tasks (id, human_id, project_id, title, description_json, description_text, status, rank, created_at, updated_at, title_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, humanId, input.projectId, title, JSON.stringify(description), plainTextFromDocument(description), status, rank, timestamp, timestamp, titleSource);
      if (titleSource === "fallback") {
        this.database.db.prepare(`INSERT INTO task_title_jobs
          (task_id, origin, source_version, source_title, description_json, created_at, updated_at) VALUES (?, 'new_task', 1, ?, ?, ?, ?)`)
          .run(id, title, JSON.stringify(description), timestamp, timestamp);
      }
      this.database.db.prepare(`
        INSERT INTO task_presence (task_id, message, tone, updated_at) VALUES (?, 'Not started', 'neutral', ?)
      `).run(id, timestamp);
      this.database.db.prepare("UPDATE projects SET next_task_number = next_task_number + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, input.projectId);
      this.saveVersion(id, 1, title, description, actor);
      this.activity({ taskId: id, projectId: input.projectId, actor, eventType: "task.created", details: { humanId, status } });
      return id;
    });
    return this.getTask(create());
  }

  listTasks(options: { tab?: "all" | "active" | "backlog" | "todo" | "open" | "closed"; projectId?: string; order?: "conversation" } = {}): TaskSummary[] {
    const statuses = options.tab === "all"
      ? [...TASK_LIST_STATUSES]
      : !options.tab
        ? ["backlog"]
      : options.tab === "active"
        ? ["backlog", "todo", "in_progress", "in_review"]
        : options.tab === "open" ? ["in_progress", "in_review"] : [options.tab];
    const params: unknown[] = [...statuses];
    let where = `t.status IN (${statuses.map(() => "?").join(",")})`;
    if (options.projectId) {
      where += " AND t.project_id = ?";
      params.push(options.projectId);
    }
    // Conversation ordering is presentation only; queue callers retain status/rank order.
    const conversation = options.order === "conversation";
    const order = conversation ? "CASE WHEN t.pinned_at IS NOT NULL THEN 0 WHEN session_state = 'running' THEN 1 ELSE 2 END, conversation_activity_at DESC, t.created_at DESC, t.id ASC" : options.tab === "all" || options.tab === "active"
      ? `CASE t.status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'todo' THEN 2 WHEN 'backlog' THEN 3 ELSE 4 END,
        t.rank, t.created_at`
      : "t.rank, t.created_at";
    const rows = this.database.db.prepare(`${this.taskSelect(conversation)} WHERE ${where} ORDER BY ${order}`).all(...params) as TaskRow[];
    return rows.map(taskFromRow);
  }

  getTask(idOrHumanId: string, includeResolved = true): TaskDetail {
    const row = this.database.db.prepare(`${this.taskSelect()} WHERE t.id = ? OR t.human_id = ?`).get(idOrHumanId, idOrHumanId) as
      | TaskRow
      | undefined;
    assertDomain(row, "Task not found", "task_not_found", 404);
    const comments = this.commentsForTask(row.id, includeResolved);
    return {
      ...taskFromRow(row), rootDirectory: row.root_directory, description: parseDocument(row.description_json), comments,
      idleNotificationsEnabled: Boolean(row.idle_notifications_enabled),
      canEdit: this.taskContentEditable(row),
      outputs: this.outputsForTask(row.id),
      latestHandoff: [...comments].reverse().find((comment) => comment.kind === "handoff") ?? null,
      relatedTasks: this.relatedTasksForTask(row.id),
    };
  }

  setPinned(id: string, pinned: unknown): TaskDetail {
    assertDomain(typeof pinned === "boolean", "Pinned must be true or false", "invalid_task_pin");
    const task = this.getTask(id);
    // Keep content versions, activity timestamps and queue rank untouched.
    this.database.db.prepare("UPDATE tasks SET pinned_at = ? WHERE id = ?")
      .run(pinned ? task.pinnedAt ?? now() : null, task.id);
    return this.getTask(task.id);
  }

  setIdleNotifications(id: string, enabled: unknown): TaskDetail {
    assertDomain(typeof enabled === "boolean", "Idle notifications must be enabled or disabled", "invalid_idle_notifications");
    const task = this.getTask(id);
    this.database.db.prepare("UPDATE tasks SET idle_notifications_enabled = ? WHERE id = ?").run(Number(enabled), task.id);
    return this.getTask(task.id);
  }

  addRelatedTask(id: string, relatedId: string, actor: Actor): TaskDetail {
    const task = this.getTask(id);
    const related = this.getTask(relatedId);
    assertDomain(task.id !== related.id, "A task cannot be related to itself", "self_relationship");
    const [lowId, highId] = [task.id, related.id].sort();
    const result = this.database.db.prepare(`
      INSERT OR IGNORE INTO task_relationships (task_low_id, task_high_id, created_at, created_by)
      VALUES (?, ?, ?, ?)
    `).run(lowId, highId, now(), actor);
    if (result.changes > 0) {
      this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "task.relationship_added", details: { relatedTaskId: related.humanId } });
      this.activity({ taskId: related.id, projectId: related.projectId, actor, eventType: "task.relationship_added", details: { relatedTaskId: task.humanId } });
    }
    return this.getTask(task.id);
  }

  removeRelatedTask(id: string, relatedId: string, actor: Actor): TaskDetail {
    const task = this.getTask(id);
    const related = this.getTask(relatedId);
    assertDomain(task.id !== related.id, "A task cannot be related to itself", "self_relationship");
    const [lowId, highId] = [task.id, related.id].sort();
    const result = this.database.db.prepare(
      "DELETE FROM task_relationships WHERE task_low_id = ? AND task_high_id = ?",
    ).run(lowId, highId);
    if (result.changes > 0) {
      this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "task.relationship_removed", details: { relatedTaskId: related.humanId } });
      this.activity({ taskId: related.id, projectId: related.projectId, actor, eventType: "task.relationship_removed", details: { relatedTaskId: task.humanId } });
    }
    return this.getTask(task.id);
  }

  private taskContentEditable(task: Pick<TaskRow, "id" | "status" | "session_kind">): boolean {
    return task.session_kind === "codex" && ["backlog", "todo"].includes(task.status)
      && !this.database.db.prepare(`SELECT 1 FROM agent_sessions WHERE owner_type = 'task' AND owner_id = ?
        AND (run_state != 'not_started' OR thread_id IS NOT NULL OR active_turn_id IS NOT NULL OR starting_message_id IS NOT NULL)`).get(task.id)
      && !this.database.db.prepare(`SELECT 1 FROM session_events WHERE owner_type = 'task' AND owner_id = ?
        AND event_type = 'turn.started' LIMIT 1`).get(task.id);
  }

  updateTask(id: string, input: { title?: string; description?: RichTextDocument; expectedVersion: number }, actor: Actor): TaskDetail {
    // Share the write lock with startup, cancellation, title generation and other editors.
    return this.database.db.transaction(() => {
      const task = this.getTask(id);
      if (actor === "user") assertDomain(task.canEdit,
        "This task has already started or closed. Your draft is kept.", "task_started", 409);
      assertDomain(Number.isSafeInteger(input?.expectedVersion) && input.expectedVersion > 0,
        "A saved task version is required", "invalid_version");
      assertDomain(task.version === input.expectedVersion, "Task changed since it was opened. Your draft is kept.", "version_conflict", 409);
      assertDomain(input.title === undefined || typeof input.title === "string", "Title must be text", "invalid_title");
      const title = input.title?.trim() ?? task.title;
      const description = validateDocument(input.description ?? task.description);
      assertDomain(title.length >= 1 && title.length <= 200, "Title must be 1–200 characters", "invalid_title");
      const version = task.version + 1;
      this.database.db.prepare(`
        UPDATE tasks SET title = ?, description_json = ?, description_text = ?, version = ?, updated_at = ?,
          title_source = CASE WHEN ? THEN 'manual' ELSE title_source END WHERE id = ?
      `).run(title, JSON.stringify(description), plainTextFromDocument(description), version, now(), input.title !== undefined ? 1 : 0, task.id);
      this.saveVersion(task.id, version, title, description, actor);
      this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "task.edited", details: { version } });
      return this.getTask(task.id);
    }).immediate();
  }

  transition(
    id: string,
    input: { to: TaskStatus; outcome?: Exclude<TaskOutcome, null>; explicitUserInstruction?: string; onlyIfUnstarted?: boolean },
    actor: Actor,
  ): TaskDetail {
    // Serialize eligibility, closure and queue removal with dispatch reservation,
    // including callers using another database connection (such as MCP).
    return this.database.db.transaction(() => {
      const task = this.getTask(id);
      assertDomain(input.onlyIfUnstarted === undefined || typeof input.onlyIfUnstarted === "boolean",
        "onlyIfUnstarted must be true or false", "invalid_cancellation");
      if (input.onlyIfUnstarted) {
        assertDomain(input.to === "closed" && input.outcome === "cancelled", "Unstarted guard requires cancellation", "invalid_cancellation");
        assertDomain(task.status === "backlog" || task.status === "todo",
          "This task has already started or closed. Refresh before cancelling it.", "task_started", 409);
      }
      assertDomain(TRANSITIONS[task.status].includes(input.to), `Cannot move ${task.status} to ${input.to}`, "invalid_transition", 409);
      assertDomain(
        !(task.status === "in_review" && input.to === "in_progress") || actor === "codex",
        "Only Codex can return an in-review task to work",
        "invalid_transition",
        409,
      );
      const outcome = input.to === "closed" ? input.outcome : null;
      if (input.to === "closed") {
        assertDomain(!this.database.db.prepare("SELECT 1 FROM terminal_sessions WHERE task_id = ? AND state = 'running'").get(task.id),
          "Exit the running shell before closing this terminal", "terminal_running", 409);
        assertDomain(outcome === "completed" || outcome === "cancelled", "Closed tasks need an outcome", "outcome_required");
        assertDomain(!["running", "waiting"].includes(task.sessionState)
          && !this.database.db.prepare("SELECT 1 FROM agent_sessions WHERE owner_type = 'task' AND owner_id = ? AND (starting_message_id IS NOT NULL OR active_turn_id IS NOT NULL)").get(task.id),
          "Pause this task before cancelling or completing it.", "task_running", 409);
        if (input.onlyIfUnstarted) {
          assertDomain(!this.database.db.prepare(`SELECT 1 FROM session_events WHERE owner_type = 'task' AND owner_id = ? AND event_type = 'turn.started'
            AND id > COALESCE((SELECT MAX(id) FROM session_events WHERE owner_type='task' AND owner_id=? AND event_type='session.restored'),0) LIMIT 1`).get(task.id, task.id),
            "This task has already started. Refresh before cancelling it.", "task_started", 409);
        }
        if (actor === "codex") {
          assertDomain(
            Boolean(input.explicitUserInstruction?.trim()),
            "Codex may close a task only with an explicit user instruction",
            "explicit_instruction_required",
            403,
          );
        }
      }
      const timestamp = now();
      this.database.db.prepare("UPDATE tasks SET status = ?, outcome = ?, rank = ?, updated_at = ? WHERE id = ?")
        .run(input.to, outcome, this.nextRank(input.to), timestamp, task.id);
      if (input.to === "closed") new MessageSchedules(this.database, this).cancelTask(task.id, "Conversation closed; scheduled delivery cancelled");
      if (input.to === "closed") {
        // Pending files become ordinary history with the normal retention period.
        this.database.db.prepare(`UPDATE attachment_uploads SET expires_at = MAX(expires_at, ?)
          WHERE message_id IN (SELECT m.id FROM chat_messages m JOIN pending_messages p ON p.message_id = m.id
            WHERE m.owner_type = 'task' AND m.owner_id = ?)`)
          .run(new Date(Date.now() + ATTACHMENT_LIMITS.completedMs).toISOString(), task.id);
        this.database.db.prepare(`DELETE FROM pending_messages WHERE message_id IN
          (SELECT id FROM chat_messages WHERE owner_type = 'task' AND owner_id = ?)`).run(task.id);
        this.database.db.prepare("DELETE FROM scheduler_queue WHERE task_id = ?").run(task.id);
        const schedules = new TaskSchedules(this.database, this);
        if (["pending", "reserved"].includes(schedules.get(task.id)?.state ?? "")) schedules.setState(task.id, "cancelled", "Task was closed");
        this.database.db.prepare("UPDATE task_presence SET message = ?, tone = ?, updated_at = ? WHERE task_id = ?")
          .run(outcome === "completed" ? "Completed" : "Cancelled", outcome === "completed" ? "green" : "neutral", timestamp, task.id);
      }
      this.activity({
        taskId: task.id, projectId: task.projectId, actor, eventType: "task.status_changed",
        details: { from: task.status, to: input.to, outcome, explicitUserInstruction: input.explicitUserInstruction },
      });
      return this.getTask(task.id);
    }).immediate();
  }

  restoreCodex(id: string, expectedVersion: unknown): TaskDetail {
    return this.database.db.transaction(() => {
      const task = this.getTask(id);
      assertDomain((task.sessionKind ?? "codex") === "codex", "Use terminal session controls to restore a terminal", "invalid_session_kind", 409);
      assertDomain(typeof expectedVersion === "number" && Number.isSafeInteger(expectedVersion) && expectedVersion > 0,
        "A saved task version is required", "invalid_version");
      assertDomain(task.version === expectedVersion && task.status === "closed",
        "This session changed. Refresh before restoring it.", "restore_conflict", 409);
      assertDomain(!this.database.db.prepare(`SELECT 1 FROM agent_sessions WHERE owner_type = 'task' AND owner_id = ?
        AND (run_state IN ('running','waiting') OR starting_message_id IS NOT NULL)`).get(task.id),
        "Interrupt the active session before restoring it.", "task_running", 409);
      const timestamp = now();
      // Increment the version so a delayed retry cannot reopen a later closure.
      new MessageSchedules(this.database, this).cancelTask(task.id, "Session restored; scheduled delivery cancelled", true);
      this.database.db.prepare(`UPDATE tasks SET status = 'backlog', outcome = NULL, version = version + 1,
        rank = ?, updated_at = ? WHERE id = ?`).run(this.nextRank("backlog"), timestamp, task.id);
      this.saveVersion(task.id, task.version + 1, task.title, task.description, "user");
      this.database.db.prepare(`UPDATE attachment_uploads SET expires_at = MAX(expires_at, ?)
        WHERE message_id IN (SELECT m.id FROM chat_messages m JOIN pending_messages p ON p.message_id = m.id
          WHERE m.owner_type = 'task' AND m.owner_id = ?)`).run(new Date(Date.now() + ATTACHMENT_LIMITS.completedMs).toISOString(), task.id);
      this.database.db.prepare(`DELETE FROM pending_messages WHERE message_id IN
        (SELECT id FROM chat_messages WHERE owner_type = 'task' AND owner_id = ?)`).run(task.id);
      this.database.db.prepare("DELETE FROM scheduler_queue WHERE task_id = ?").run(task.id);
      const schedules = new TaskSchedules(this.database, this);
      if (["pending", "reserved"].includes(schedules.get(task.id)?.state ?? "")) schedules.setState(task.id, "cancelled", "Session restored; automatic startup disabled");
      this.database.db.prepare(`UPDATE pending_requests SET status = 'expired', resolved_at = ?
        WHERE owner_type = 'task' AND owner_id = ? AND status = 'pending'`).run(timestamp, task.id);
      this.database.db.prepare(`UPDATE agent_sessions SET active_turn_id = NULL, starting_message_id = NULL,
        run_state = CASE WHEN thread_id IS NULL THEN 'not_started' ELSE 'idle' END,
        generation = generation + 1, last_error = NULL, updated_at = ? WHERE owner_type = 'task' AND owner_id = ?`).run(timestamp, task.id);
      this.database.db.prepare(`INSERT INTO session_events(owner_type,owner_id,event_type,created_at)
        VALUES ('task',?,'session.restored',?)`).run(task.id, timestamp);
      this.database.db.prepare(`INSERT INTO task_presence(task_id,message,tone,reason,updated_at)
        VALUES (?,'Restored to Backlog','neutral','Waiting for your next request',?)
        ON CONFLICT(task_id) DO UPDATE SET message=excluded.message,tone=excluded.tone,reason=excluded.reason,updated_at=excluded.updated_at`).run(task.id, timestamp);
      this.activity({ taskId: task.id, projectId: task.projectId, actor: "user", eventType: "task.restored",
        details: { from: "closed", outcome: task.outcome, to: "backlog", previousVersion: task.version } });
      return this.getTask(task.id);
    }).immediate();
  }

  restoreTerminal(id: string): TaskDetail {
    return this.database.db.transaction(() => {
      const task = this.getTask(id);
      assertDomain(task.sessionKind === "terminal" && task.status === "closed",
        "Only closed terminal sessions can be restored", "terminal_not_closed", 409);
      this.database.db.prepare("UPDATE tasks SET status = 'backlog', outcome = NULL, rank = ?, updated_at = ? WHERE id = ?")
        .run(this.nextRank("backlog"), now(), task.id);
      this.activity({ taskId: task.id, projectId: task.projectId, actor: "user", eventType: "terminal.restored" });
      return this.getTask(task.id);
    }).immediate();
  }

  reorder(id: string, input: { beforeId?: string | null; afterId?: string | null }, actor: Actor): TaskDetail {
    const task = this.getTask(id);
    assertDomain(task.status === "backlog" || task.status === "todo", "Only Backlog and Todo tasks can be reordered", "not_reorderable", 409);
    const before = input.beforeId ? this.getTask(input.beforeId) : null;
    const after = input.afterId ? this.getTask(input.afterId) : null;
    for (const neighbor of [before, after]) {
      assertDomain(!neighbor || neighbor.status === task.status, "Reorder neighbors must share the same status", "invalid_reorder", 409);
    }
    let rank = before && after ? (before.rank + after.rank) / 2 : before ? before.rank + 1024 : after ? after.rank - 1024 : 1024;
    if (this.database.db.prepare("SELECT 1 FROM tasks WHERE status = ? AND rank = ? AND id != ?").get(task.status, rank, task.id)) {
      rank += before && after ? Math.min(0.001, (after.rank - before.rank) / 4) : 0.001;
    }
    this.database.db.prepare("UPDATE tasks SET rank = ?, updated_at = ? WHERE id = ?").run(rank, now(), task.id);
    this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "task.reordered", details: { rank } });
    return this.getTask(task.id);
  }

  prioritize(humanIds: string[], actor: Actor): void {
    const requested = [...new Set(humanIds)];
    assertDomain(requested.length > 0 && requested.length <= 200, "Priority list must contain 1–200 tasks", "invalid_priority");
    const tasks = requested.map((id) => this.getTask(id));
    assertDomain(tasks.every((task) => task.status !== "closed"), "Closed tasks cannot be prioritized", "invalid_priority", 409);
    const activeTasks = this.listTasks({ tab: "active" });
    this.database.db.transaction(() => {
      for (const status of ["backlog", "todo", "in_progress", "in_review"] as TaskStatus[]) {
        const selected = tasks.filter((task) => task.status === status);
        if (!selected.length) continue;
        const selectedIds = new Set(selected.map((task) => task.id));
        const remaining = activeTasks.filter((task) => task.status === status && !selectedIds.has(task.id));
        [...selected, ...remaining].forEach((task, index) => {
          this.database.db.prepare("UPDATE tasks SET rank = ?, updated_at = ? WHERE id = ?").run((index + 1) * 1024, now(), task.id);
        });
        for (const task of selected) this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "task.reordered", details: { source: "orchestrator-priority" } });
      }
    })();
  }

  deleteBacklogTask(id: string, actor: Actor): void {
    const task = this.getTask(id);
    assertDomain(!this.database.db.prepare("SELECT 1 FROM terminal_sessions WHERE task_id = ? AND state = 'running'").get(task.id),
      "Exit the running shell before deleting this terminal", "terminal_running", 409);
    assertDomain(task.status === "backlog", "Only Backlog tasks can be deleted", "task_not_deletable", 409);
    this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "task.deleted", details: { humanId: task.humanId } });
    this.database.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
  }

  addComment(
    taskId: string,
    input: { body: RichTextDocument; parentId?: string; requiresResponse?: boolean; kind?: CommentKind; metadata?: Record<string, unknown> },
    actor: Actor,
  ): TaskComment {
    const task = this.getTask(taskId);
    const anchor = input.metadata?.canvas as { pageId?: unknown } | undefined;
    if (anchor && anchor.pageId !== undefined) requireDesignPage(this.database.db, task.id, anchor.pageId);
    const body = validateDocument(input.body);
    const plainText = plainTextFromDocument(body);
    assertDomain(plainText.length > 0, "Comment cannot be empty", "empty_comment");
    let parentId = input.parentId ?? null;
    if (parentId) {
      const parent = this.database.db.prepare("SELECT task_id, parent_id FROM comments WHERE id = ?").get(parentId) as
        | { task_id: string; parent_id: string | null }
        | undefined;
      assertDomain(parent?.task_id === task.id, "Parent comment not found", "comment_not_found", 404);
      parentId = parent.parent_id ?? parentId;
    }
    const id = randomUUID();
    const timestamp = now();
    this.database.db.prepare(`
      INSERT INTO comments
      (id, task_id, parent_id, author, kind, body_json, plain_text, requires_response, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, task.id, parentId, actor, input.kind ?? "comment", JSON.stringify(body), plainText,
      input.requiresResponse ? 1 : 0, input.metadata ? JSON.stringify(input.metadata) : null, timestamp, timestamp,
    );
    this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "comment.created", details: { commentId: id } });
    return this.commentById(id);
  }

  resolveComment(id: string, resolved: boolean, actor: Actor, reply?: RichTextDocument): TaskComment {
    const comment = this.commentById(id);
    const rootId = comment.parentId ?? comment.id;
    if (reply && plainTextFromDocument(reply)) this.addComment(comment.taskId, { body: reply, parentId: rootId }, actor);
    this.database.db.prepare("UPDATE comments SET resolved_at = ?, updated_at = ? WHERE id = ?")
      .run(resolved ? now() : null, now(), rootId);
    const task = this.getTask(comment.taskId);
    this.activity({
      taskId: task.id, projectId: task.projectId, actor,
      eventType: resolved ? "comment.resolved" : "comment.reopened", details: { commentId: rootId },
    });
    return this.commentById(rootId);
  }

  submitForReview(id: string, handoff: HandoffInput, actor: "codex"): TaskDetail {
    const task = this.getTask(id);
    assertDomain(task.status === "in_progress", "Only in-progress tasks can be submitted", "invalid_transition", 409);
    this.addOutput(task.id, { ...handoff, runId: handoff.runId ?? randomUUID() }, actor);
    return this.transition(task.id, { to: "in_review" }, actor);
  }

  addOutput(taskId: string, input: HandoffInput, actor: "codex"): TaskOutput {
    const task = this.getTask(taskId);
    const summary = input.summary.trim();
    assertDomain(summary.length > 0 && summary.length <= 10_000, "Output summary must be 1–10,000 characters", "invalid_output");
    const validation = this.outputList(input.validation);
    const limitations = this.outputList(input.limitations);
    const artifacts = this.artifactList(input.artifacts);
    assertDomain(!(input.commit && input.commitProposal), "An output cannot contain both an existing commit and a commit proposal", "invalid_output");
    const proposal = input.commitProposal ? this.reviewedCommits.prepare(task.rootDirectory, input.commitProposal) : null;
    const id = randomUUID();
    const createdAt = now();
    this.database.db.prepare(`
      INSERT INTO task_outputs
      (id, task_id, summary, validation_json, commit_hash, limitations_json, session_id, run_id, artifacts_json,
       commit_proposal_json, commit_approval_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, task.id, summary, JSON.stringify(validation), input.commit?.trim() || null,
      JSON.stringify(limitations), input.sessionId?.trim() || null, input.runId?.trim() || null,
      JSON.stringify(artifacts), proposal ? JSON.stringify(proposal) : null, proposal ? "pending" : null, createdAt,
    );
    this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "output.created", details: { outputId: id } });
    return this.outputById(id);
  }

  approveOutputCommit(taskId: string, outputId: string, actor: "user"): TaskDetail {
    const task = this.getTask(taskId);
    assertDomain(task.status === "in_review", "Only an in-review task output can be approved for commit", "commit_not_eligible", 409);
    const row = this.outputRow(outputId);
    assertDomain(row.task_id === task.id, "Output not found", "output_not_found", 404);
    assertDomain(row.commit_proposal_json, "This output has no commit proposal", "commit_not_eligible", 409);
    if (row.commit_approval_status === "committed") return task;
    assertDomain(row.commit_approval_status === "pending", "Commit approval is already being processed", "commit_in_progress", 409);
    this.validatePublishFollowup(task.projectId);
    const claimed = this.database.db.prepare(`
      UPDATE task_outputs SET commit_approval_status = 'processing'
      WHERE id = ? AND commit_approval_status = 'pending'
    `).run(row.id);
    assertDomain(claimed.changes === 1, "Commit approval is already being processed", "commit_in_progress", 409);
    let commit: string | null = null;
    try {
      const proposal = JSON.parse(row.commit_proposal_json) as StoredCommitProposal;
      commit = this.reviewedCommits.commit(proposal);
      this.recordApprovedCommit(task, row.id, proposal, commit, actor);
      return this.getTask(task.id);
    } catch (error) {
      if (!commit) this.database.db.prepare("UPDATE task_outputs SET commit_approval_status = 'pending' WHERE id = ?").run(row.id);
      throw error;
    }
  }

  activityForTask(id: string, limit = 50): unknown[] {
    const task = this.getTask(id);
    return this.database.db.prepare(`
      SELECT actor, event_type AS eventType, details_json AS detailsJson, created_at AS createdAt
      FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT ?
    `).all(task.id, Math.min(200, Math.max(1, limit))).map((row) => {
      const value = row as { actor: Actor; eventType: string; detailsJson: string | null; createdAt: string };
      return { ...value, details: value.detailsJson ? JSON.parse(value.detailsJson) : null, detailsJson: undefined };
    });
  }

  exportData(): Record<string, unknown> {
    return {
      exportedAt: now(), version: 2, projects: this.listProjects(true),
      tasks: (this.database.db.prepare("SELECT human_id FROM tasks ORDER BY created_at").all() as Array<{ human_id: string }>).map(
        (row) => this.getTask(row.human_id, true),
      ),
    };
  }

  private getProject(id: string): Project {
    const row = this.database.db.prepare(`
      SELECT p.*, COUNT(t.id) AS task_count FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
      WHERE p.id = ? GROUP BY p.id
    `).get(id) as ProjectRow | undefined;
    assertDomain(row, "Project not found", "project_not_found", 404);
    return projectFromRow(row);
  }

  private validateRoot(value: string): string {
    const root = resolve(value.trim());
    assertDomain(isAbsolute(value.trim()), "Root directory must be an absolute path", "invalid_root_directory");
    try {
      assertDomain(statSync(root).isDirectory(), "Root directory must be a directory", "invalid_root_directory");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("Root directory does not exist", "invalid_root_directory");
    }
    return root;
  }

  private suggestPrefix(name: string): string {
    const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
    if (words.length > 1) return words.map((word) => word[0]).join("").slice(0, 6).padEnd(2, "X");
    return (words[0] ?? "PRJ").slice(0, 3).padEnd(2, "X");
  }

  private descriptionFromSections(sections?: CreateTaskInput["sections"]): RichTextDocument {
    if (!sections) return emptyDocument();
    return documentFromSections([
      { heading: "Goal", body: sections.goal ?? "" },
      { heading: "Details", body: sections.details ?? "" },
      { heading: "Done when", body: sections.doneWhen ?? [] },
    ]);
  }

  private nextRank(status: TaskStatus): number {
    const row = this.database.db.prepare("SELECT MAX(rank) AS maximum FROM tasks WHERE status = ?").get(status) as { maximum: number | null };
    return (row.maximum ?? 0) + 1024;
  }

  private taskSelect(conversation = false): string {
    return `SELECT t.*, p.name AS project_name, p.prefix AS project_prefix, p.root_directory,
      p.logo_mime_type AS project_logo_mime_type, p.logo_size AS project_logo_size,
      p.logo_updated_at AS project_logo_updated_at,
      COALESCE(tp.message, CASE WHEN t.status = 'closed' THEN 'Completed' ELSE 'Not started' END) AS smart_message,
      COALESCE(tp.tone, CASE WHEN t.status = 'closed' AND t.outcome = 'completed' THEN 'green' ELSE 'neutral' END) AS tone,
      CASE WHEN t.session_kind = 'terminal' THEN CASE ts.state WHEN 'running' THEN 'running' WHEN 'exited' THEN 'idle' ELSE COALESCE(ts.state, 'failed') END ELSE COALESCE(s.run_state, 'not_started') END AS session_state,
      CASE WHEN t.session_kind = 'terminal' THEN 'chat' ELSE COALESCE(s.surface, 'undecided') END AS surface,
      COALESCE(ts.updated_at, s.updated_at) AS last_activity_at,
      ${conversation ? `COALESCE(ts.updated_at, latest.created_at, t.created_at) AS conversation_activity_at,
      latest.body AS latest_message_body, latest.role AS latest_message_role, latest.created_at AS latest_message_at,
      (SELECT COUNT(*) FROM chat_messages m LEFT JOIN chat_message_reads r ON r.message_id = m.id
        WHERE m.owner_type = 'task' AND m.owner_id = t.id AND m.role = 'assistant'
          AND COALESCE(json_extract(m.metadata_json, '$.queueScheduling'), 0) != 1 AND r.message_id IS NULL) AS conversation_unread_count,` : ""}
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id AND c.kind = 'comment' AND c.parent_id IS NULL AND c.resolved_at IS NULL) AS unresolved_comment_count
      FROM tasks t JOIN projects p ON p.id = t.project_id
      LEFT JOIN task_presence tp ON tp.task_id = t.id
      LEFT JOIN agent_sessions s ON s.owner_type = 'task' AND s.owner_id = t.id
      LEFT JOIN terminal_sessions ts ON ts.task_id = t.id
      ${conversation ? `LEFT JOIN chat_messages latest ON latest.id = (
        SELECT m.id FROM chat_messages m WHERE m.owner_type = 'task' AND m.owner_id = t.id
          AND m.role IN ('user', 'assistant') AND COALESCE(json_extract(m.metadata_json, '$.queueScheduling'), 0) != 1
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)` : ""}`;
  }

  private logoDirectory(): string {
    return join(this.database.dataDir, "project-logos");
  }

  private logoFilename(id: string): string | null {
    const row = this.database.db.prepare("SELECT logo_filename FROM projects WHERE id = ?").get(id) as { logo_filename: string | null } | undefined;
    return row?.logo_filename ?? null;
  }

  private safeLogoPath(filename: string): string {
    assertDomain(basename(filename) === filename, "Invalid stored project logo", "invalid_project_logo", 500);
    return join(this.logoDirectory(), filename);
  }

  private removeLogoFile(filename: string | null): void {
    if (!filename) return;
    try { unlinkSync(this.safeLogoPath(filename)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private commentsForTask(taskId: string, includeResolved: boolean): TaskComment[] {
    const rows = this.database.db.prepare(`
      SELECT * FROM comments WHERE task_id = ? ${includeResolved ? "" : "AND (parent_id IS NOT NULL OR resolved_at IS NULL)"}
      ORDER BY created_at
    `).all(taskId) as CommentRow[];
    const mapped = new Map(rows.map((row) => [row.id, this.commentFromRow(row)]));
    const roots: TaskComment[] = [];
    for (const row of rows) {
      const comment = mapped.get(row.id)!;
      if (row.parent_id && mapped.has(row.parent_id)) mapped.get(row.parent_id)!.replies.push(comment);
      else if (!row.parent_id) roots.push(comment);
    }
    return roots;
  }

  private outputsForTask(taskId: string): TaskOutput[] {
    const task = this.getTaskRow(taskId);
    const rows = this.database.db.prepare("SELECT * FROM task_outputs WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as OutputRow[];
    return rows.map((row) => this.outputFromRow(row, task.root_directory));
  }

  private relatedTasksForTask(taskId: string): RelatedTask[] {
    return this.database.db.prepare(`
      SELECT t.id, t.human_id, t.project_id, p.name AS project_name, p.prefix AS project_prefix,
        t.title, t.status, t.outcome
      FROM task_relationships r
      JOIN tasks t ON t.id = CASE WHEN r.task_low_id = ? THEN r.task_high_id ELSE r.task_low_id END
      JOIN projects p ON p.id = t.project_id
      WHERE r.task_low_id = ? OR r.task_high_id = ?
      ORDER BY p.name COLLATE NOCASE, t.human_id COLLATE NOCASE
    `).all(taskId, taskId, taskId).map((row) => {
      const value = row as {
        id: string; human_id: string; project_id: string; project_name: string; project_prefix: string;
        title: string; status: TaskStatus; outcome: TaskOutcome;
      };
      return {
        id: value.id, humanId: value.human_id, projectId: value.project_id,
        projectName: value.project_name, projectPrefix: value.project_prefix, title: value.title,
        status: value.status, outcome: value.outcome,
      };
    });
  }

  private outputById(id: string): TaskOutput {
    const row = this.database.db.prepare(`
      SELECT o.* FROM task_outputs o WHERE o.id = ?
    `).get(id) as OutputRow | undefined;
    assertDomain(row, "Output not found", "output_not_found", 404);
    return this.outputFromRow(row, this.getTaskRow(row.task_id).root_directory);
  }

  private outputFromRow(row: OutputRow, rootDirectory: string): TaskOutput {
    const stored = JSON.parse(row.artifacts_json) as ArtifactReference[];
    return {
      id: row.id, taskId: row.task_id, summary: row.summary,
      validation: JSON.parse(row.validation_json) as string[], commit: row.commit_hash,
      limitations: JSON.parse(row.limitations_json) as string[], sessionId: row.session_id, runId: row.run_id,
      artifacts: stored.map((artifact, index) => this.describeArtifact(row.task_id, row.id, index, artifact, rootDirectory)),
      commitApproval: this.commitApproval(row),
      sourceCommentId: row.source_comment_id, createdAt: row.created_at,
    };
  }

  private outputRow(id: string): OutputRow {
    const row = this.database.db.prepare("SELECT * FROM task_outputs WHERE id = ?").get(id) as OutputRow | undefined;
    assertDomain(row, "Output not found", "output_not_found", 404);
    return row;
  }

  private commitApproval(row: OutputRow): CommitApproval | null {
    if (!row.commit_proposal_json) return null;
    const stored = JSON.parse(row.commit_proposal_json) as StoredCommitProposal;
    return {
      message: stored.message, repositoryRoot: stored.repositoryRoot, baseRevision: stored.baseRevision,
      files: stored.files, releaseNote: stored.releaseNote,
      status: row.commit_approval_status === "committed" ? "committed" : "pending",
      commitHash: row.approved_commit_hash,
    };
  }

  private validatePublishFollowup(projectId: string): void {
    const rows = this.database.db.prepare(`
      SELECT id FROM tasks WHERE project_id = ? AND title = 'Publish/deploy changes' COLLATE NOCASE AND status != 'closed'
    `).all(projectId) as Array<{ id: string }>;
    assertDomain(rows.length <= 1, "Project has multiple active publish/deploy tasks", "publish_task_conflict", 409);
  }

  private recordApprovedCommit(
    source: TaskDetail,
    outputId: string,
    proposal: StoredCommitProposal,
    commit: string,
    actor: Actor,
  ): void {
    const apply = this.database.db.transaction(() => {
      this.database.db.prepare(`
        UPDATE task_outputs SET commit_hash = ?, approved_commit_hash = ?, commit_approval_status = 'committed' WHERE id = ?
      `).run(commit, commit, outputId);
      const existing = this.database.db.prepare(`
        SELECT id FROM tasks WHERE project_id = ? AND title = 'Publish/deploy changes' COLLATE NOCASE AND status != 'closed'
      `).get(source.projectId) as { id: string } | undefined;
      const entry = `${commit} — ${source.humanId}: ${proposal.releaseNote}`;
      let followup: TaskDetail;
      if (existing) {
        followup = this.getTask(existing.id);
        const description = structuredClone(followup.description);
        description.content = [...(description.content ?? []), { type: "paragraph", content: [{ type: "text", text: entry }] }];
        followup = this.updateTask(followup.id, { description, expectedVersion: followup.version }, "system");
      } else {
        followup = this.createTask({
          projectId: source.projectId, title: "Publish/deploy changes", status: "todo",
          sections: {
            goal: "Publish or deploy the project's approved commits when separately authorized.",
            details: [entry],
            doneWhen: ["Each listed commit is pushed, published, or deployed only with explicit authorization."],
          },
        }, "system");
      }
      const [lowId, highId] = [source.id, followup.id].sort();
      this.database.db.prepare(`
        INSERT OR IGNORE INTO task_relationships (task_low_id, task_high_id, created_at, created_by) VALUES (?, ?, ?, ?)
      `).run(lowId, highId, now(), actor);
      this.activity({
        taskId: source.id, projectId: source.projectId, actor, eventType: "output.commit_approved",
        details: { outputId, commit, followupTaskId: followup.humanId },
      });
    });
    apply();
  }

  artifactFile(taskId: string, outputId: string, index: number): { path: string; filename: string; mediaType: string; size: number } {
    const task = this.getTask(taskId);
    const row = this.database.db.prepare("SELECT * FROM task_outputs WHERE id = ? AND task_id = ?")
      .get(outputId, task.id) as OutputRow | undefined;
    assertDomain(row, "Output not found", "output_not_found", 404);
    const stored = JSON.parse(row.artifacts_json) as ArtifactReference[];
    const reference = stored[index];
    assertDomain(reference !== undefined, "Artifact not found", "artifact_not_found", 404);
    const artifact = this.describeArtifact(task.id, row.id, index, reference, task.rootDirectory);
    assertDomain(artifact.sourceType === "path", "Only local artifacts are served", "artifact_not_local", 400);
    assertDomain(artifact.availability !== "outside_scope", "Artifact is outside the project root", "artifact_outside_scope", 403);
    assertDomain(artifact.availability !== "missing", "Artifact is no longer available", "artifact_missing", 404);
    assertDomain(artifact.availability !== "unsupported" && artifact.mediaType, "Artifact type is not supported", "artifact_unsupported", 415);
    const path = realpathSync(this.localArtifactPath(task.rootDirectory, artifact.source));
    return { path, filename: artifact.filename, mediaType: artifact.mediaType, size: artifact.size ?? statSync(path).size };
  }

  private outputList(values: string[] | undefined): string[] {
    const result = (values ?? []).map((value) => value.trim()).filter(Boolean);
    assertDomain(result.length <= 100 && result.every((value) => value.length <= 2_000), "Output lists are too long", "invalid_output");
    return result;
  }

  private artifactList(values: ArtifactReference[] | undefined): ArtifactReference[] {
    const result = (values ?? []).map((value) => {
      if (typeof value === "string") return value.trim();
      return {
        ...(value.path?.trim() ? { path: value.path.trim() } : {}),
        ...(value.url?.trim() ? { url: value.url.trim() } : {}),
        ...(value.filename?.trim() ? { filename: value.filename.trim() } : {}),
        ...(value.mediaType?.trim() ? { mediaType: value.mediaType.trim().toLowerCase() } : {}),
        ...(Number.isSafeInteger(value.size) && Number(value.size) >= 0 ? { size: Number(value.size) } : {}),
      };
    }).filter((value) => typeof value !== "string" || Boolean(value));
    assertDomain(result.length <= 100, "Too many output artifacts", "invalid_output");
    for (const value of result) {
      const source = typeof value === "string" ? value : value.path ?? value.url;
      assertDomain(Boolean(source) && String(source).length <= 2_000, "Artifact source is invalid", "invalid_output");
      if (typeof value !== "string") {
        assertDomain(Boolean(value.path) !== Boolean(value.url), "Artifact must have exactly one path or URL", "invalid_output");
        assertDomain(!value.filename || value.filename.length <= 255, "Artifact filename is too long", "invalid_output");
      }
    }
    return result;
  }

  private describeArtifact(
    taskId: string,
    outputId: string,
    index: number,
    reference: ArtifactReference,
    rootDirectory: string,
  ): TaskArtifact {
    const value = typeof reference === "string" ? { path: reference } : reference;
    const source = value.url ?? value.path ?? "";
    const sourceType = value.url ? "url" : "path";
    let filename = value.filename?.trim() || this.artifactFilename(source);
    if (!filename) filename = "artifact";
    const inferred = ARTIFACT_MEDIA_TYPES[extname(filename).toLowerCase()];
    if (sourceType === "url") {
      const validUrl = this.validHttpUrl(source);
      const mediaType = value.mediaType?.toLowerCase() ?? inferred?.mediaType ?? null;
      const kind = Object.values(ARTIFACT_MEDIA_TYPES).find((entry) => entry.mediaType === mediaType)?.kind ?? "none";
      return {
        source, sourceType, filename, mediaType, size: value.size ?? null, previewKind: kind,
        availability: validUrl && kind !== "none" ? "external" : "unsupported",
        previewUrl: validUrl && kind !== "none" ? source : null,
      };
    }
    if (!this.pathWithinRoot(rootDirectory, source)) {
      return { source, sourceType, filename, mediaType: null, size: null, previewKind: "none", availability: "outside_scope", previewUrl: null };
    }
    const localType = ARTIFACT_MEDIA_TYPES[extname(source).toLowerCase()];
    const path = this.localArtifactPath(rootDirectory, source);
    if (!existsSync(path)) {
      return { source, sourceType, filename, mediaType: localType?.mediaType ?? null, size: null, previewKind: "none", availability: "missing", previewUrl: null };
    }
    let stats;
    try { stats = statSync(path); }
    catch { return { source, sourceType, filename, mediaType: localType?.mediaType ?? null, size: null, previewKind: "none", availability: "missing", previewUrl: null }; }
    if (!stats.isFile() || !localType) {
      return { source, sourceType, filename, mediaType: localType?.mediaType ?? null, size: stats.isFile() ? stats.size : null, previewKind: "none", availability: "unsupported", previewUrl: null };
    }
    const previewUrl = `/api/tasks/${encodeURIComponent(taskId)}/outputs/${encodeURIComponent(outputId)}/artifacts/${index}`;
    return {
      source, sourceType, filename, mediaType: localType.mediaType, size: stats.size,
      previewKind: stats.size > MAX_ARTIFACT_PREVIEW_BYTES ? "none" : localType.kind,
      availability: stats.size > MAX_ARTIFACT_PREVIEW_BYTES ? "too_large" : "available",
      previewUrl,
    };
  }

  private localArtifactPath(rootDirectory: string, source: string): string {
    let root = rootDirectory;
    try { root = realpathSync(rootDirectory); }
    catch { /* Missing roots are handled as unavailable artifacts. */ }
    return resolve(root, source);
  }

  private pathWithinRoot(rootDirectory: string, source: string): boolean {
    let root;
    try { root = realpathSync(rootDirectory); }
    catch { return false; }
    const candidate = this.localArtifactPath(rootDirectory, source);
    const lexical = relative(root, candidate);
    if (lexical.startsWith("..") || isAbsolute(lexical)) return false;
    if (!existsSync(candidate)) return true;
    const actual = realpathSync(candidate);
    const resolved = relative(root, actual);
    return !resolved.startsWith("..") && !isAbsolute(resolved);
  }

  private artifactFilename(source: string): string {
    try { return basename(new URL(source).pathname) || "artifact"; }
    catch { return basename(source); }
  }

  private validHttpUrl(value: string): boolean {
    try { return ["http:", "https:"].includes(new URL(value).protocol); }
    catch { return false; }
  }

  private getTaskRow(idOrHumanId: string): TaskRow {
    const row = this.database.db.prepare(`${this.taskSelect()} WHERE t.id = ? OR t.human_id = ?`).get(idOrHumanId, idOrHumanId) as TaskRow | undefined;
    assertDomain(row, "Task not found", "task_not_found", 404);
    return row;
  }

  private commentFromRow(row: CommentRow): TaskComment {
    return {
      id: row.id, taskId: row.task_id, parentId: row.parent_id, author: row.author, kind: row.kind,
      body: parseDocument(row.body_json), plainText: row.plain_text, requiresResponse: Boolean(row.requires_response),
      resolvedAt: row.resolved_at, metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      createdAt: row.created_at, updatedAt: row.updated_at, replies: [],
    };
  }

  private commentById(id: string): TaskComment {
    const row = this.database.db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow | undefined;
    assertDomain(row, "Comment not found", "comment_not_found", 404);
    return this.commentFromRow(row);
  }

  private saveVersion(taskId: string, version: number, title: string, description: RichTextDocument, actor: Actor): void {
    this.database.db.prepare(`
      INSERT INTO task_versions (task_id, version, title, description_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, version, title, JSON.stringify(description), actor, now());
  }

  private activity(input: { taskId?: string; projectId?: string; actor: Actor; eventType: string; details?: unknown }): void {
    this.database.db.prepare(`
      INSERT INTO activity (task_id, project_id, actor, event_type, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.taskId ?? null, input.projectId ?? null, input.actor, input.eventType, input.details ? JSON.stringify(input.details) : null, now());
  }
}
