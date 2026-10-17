import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { assertDomain, DomainError } from "../domain/errors.js";
import {
  documentFromPlainText,
  documentFromSections,
  emptyDocument,
  plainTextFromDocument,
  type Actor,
  type CommentKind,
  type HandoffInput,
  type Project,
  type RichTextDocument,
  type TaskComment,
  type TaskDetail,
  type TaskOutcome,
  type TaskStatus,
  type TaskSummary,
} from "../domain/types.js";
import type { AppDatabase } from "./database.js";

interface ProjectRow {
  id: string; name: string; prefix: string; root_directory: string; archived_at: string | null;
  task_count: number; created_at: string; updated_at: string;
}

interface TaskRow {
  id: string; human_id: string; project_id: string; project_name: string; project_prefix: string;
  root_directory: string; title: string; description_json: string; status: TaskStatus; outcome: TaskOutcome;
  rank: number; unresolved_comment_count: number; version: number; created_at: string; updated_at: string;
}

interface CommentRow {
  id: string; task_id: string; parent_id: string | null; author: Actor; kind: CommentKind; body_json: string;
  plain_text: string; requires_response: number; resolved_at: string | null; metadata_json: string | null;
  created_at: string; updated_at: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: RichTextDocument;
  sections?: { goal?: string; details?: string | string[]; doneWhen?: string[] };
  status?: "backlog" | "todo";
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo"],
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "closed"],
  in_review: ["in_progress", "closed"],
  closed: [],
};

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
    taskCount: Number(row.task_count), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function taskFromRow(row: TaskRow): TaskSummary {
  return {
    id: row.id, humanId: row.human_id, projectId: row.project_id, projectName: row.project_name,
    projectPrefix: row.project_prefix, title: row.title, status: row.status, outcome: row.outcome,
    rank: row.rank, unresolvedCommentCount: Number(row.unresolved_comment_count), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class TaskService {
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
    this.database.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  createTask(input: CreateTaskInput, actor: Actor): TaskDetail {
    const title = input.title.trim();
    assertDomain(title.length >= 1 && title.length <= 200, "Title must be 1–200 characters", "invalid_title");
    const description = validateDocument(input.description ?? this.descriptionFromSections(input.sections));
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
        INSERT INTO tasks (id, human_id, project_id, title, description_json, description_text, status, rank, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, humanId, input.projectId, title, JSON.stringify(description), plainTextFromDocument(description), status, rank, timestamp, timestamp);
      this.database.db.prepare("UPDATE projects SET next_task_number = next_task_number + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, input.projectId);
      this.saveVersion(id, 1, title, description, actor);
      this.activity({ taskId: id, projectId: input.projectId, actor, eventType: "task.created", details: { humanId, status } });
      return id;
    });
    return this.getTask(create());
  }

  listTasks(options: { tab?: "backlog" | "todo" | "open" | "closed"; projectId?: string } = {}): TaskSummary[] {
    const statuses = options.tab === "open" ? ["in_progress", "in_review"] : [options.tab ?? "backlog"];
    const params: unknown[] = [...statuses];
    let where = `t.status IN (${statuses.map(() => "?").join(",")})`;
    if (options.projectId) {
      where += " AND t.project_id = ?";
      params.push(options.projectId);
    }
    const rows = this.database.db.prepare(`${this.taskSelect()} WHERE ${where} ORDER BY t.rank, t.created_at`).all(...params) as TaskRow[];
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
      latestHandoff: [...comments].reverse().find((comment) => comment.kind === "handoff") ?? null,
    };
  }

  updateTask(id: string, input: { title?: string; description?: RichTextDocument; expectedVersion: number }, actor: Actor): TaskDetail {
    const task = this.getTask(id);
    assertDomain(task.version === input.expectedVersion, "Task changed since it was opened", "version_conflict", 409);
    const title = input.title?.trim() ?? task.title;
    const description = validateDocument(input.description ?? task.description);
    assertDomain(title.length >= 1 && title.length <= 200, "Title must be 1–200 characters", "invalid_title");
    const version = task.version + 1;
    this.database.db.prepare(`
      UPDATE tasks SET title = ?, description_json = ?, description_text = ?, version = ?, updated_at = ? WHERE id = ?
    `).run(title, JSON.stringify(description), plainTextFromDocument(description), version, now(), task.id);
    this.saveVersion(task.id, version, title, description, actor);
    this.activity({ taskId: task.id, projectId: task.projectId, actor, eventType: "task.edited", details: { version } });
    return this.getTask(task.id);
  }

  transition(
    id: string,
    input: { to: TaskStatus; outcome?: Exclude<TaskOutcome, null>; explicitUserInstruction?: string },
    actor: Actor,
  ): TaskDetail {
    const task = this.getTask(id);
    assertDomain(TRANSITIONS[task.status].includes(input.to), `Cannot move ${task.status} to ${input.to}`, "invalid_transition", 409);
    assertDomain(
      !(task.status === "in_review" && input.to === "in_progress") || actor === "codex",
      "Only Codex can return an in-review task to work",
      "invalid_transition",
      409,
    );
    const outcome = input.to === "closed" ? input.outcome : null;
    if (input.to === "closed") {
      assertDomain(outcome === "completed" || outcome === "cancelled", "Closed tasks need an outcome", "outcome_required");
      if (outcome === "completed") assertDomain(task.status === "in_review", "Only reviewed tasks can be completed", "review_required", 409);
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
    this.activity({
      taskId: task.id, projectId: task.projectId, actor, eventType: "task.status_changed",
      details: { from: task.status, to: input.to, outcome, explicitUserInstruction: input.explicitUserInstruction },
    });
    if (actor === "codex" && task.status === "todo" && input.to === "in_progress") this.enqueueNotification(task, "started");
    if (actor === "codex" && task.status === "in_progress" && input.to === "in_review") this.enqueueNotification(task, "review");
    return this.getTask(task.id);
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

  deleteBacklogTask(id: string, actor: Actor): void {
    const task = this.getTask(id);
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
    if (actor === "codex" && input.requiresResponse) this.enqueueNotification(task, "response_required");
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
    const blocks = [
      `Completed: ${handoff.summary}`,
      handoff.validation?.length ? `Validation:\n${handoff.validation.map((item) => `• ${item}`).join("\n")}` : "",
      handoff.commit ? `Commit: ${handoff.commit}` : "",
      handoff.limitations?.length ? `Limitations:\n${handoff.limitations.map((item) => `• ${item}`).join("\n")}` : "",
    ].filter(Boolean);
    this.addComment(task.id, {
      body: documentFromPlainText(blocks.join("\n\n")),
      kind: "handoff",
      metadata: { sessionId: handoff.sessionId, runId: handoff.runId ?? randomUUID(), ...handoff },
    }, actor);
    return this.transition(task.id, { to: "in_review" }, actor);
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
      exportedAt: now(), version: 1, projects: this.listProjects(true),
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

  private taskSelect(): string {
    return `SELECT t.*, p.name AS project_name, p.prefix AS project_prefix, p.root_directory,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id AND c.parent_id IS NULL AND c.resolved_at IS NULL) AS unresolved_comment_count
      FROM tasks t JOIN projects p ON p.id = t.project_id`;
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

  private enqueueNotification(task: TaskSummary, eventType: "started" | "review" | "response_required"): void {
    const id = randomUUID();
    this.database.db.prepare(`
      INSERT INTO notification_outbox (id, event_type, task_id, payload_json, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, eventType, task.id, JSON.stringify({
      taskHumanId: task.humanId, taskTitle: task.title, projectName: task.projectName,
    }), now(), now());
  }
}
