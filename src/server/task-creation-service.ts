import { randomUUID } from "node:crypto";
import { assertDomain } from "../domain/errors.js";
import type { AppDatabase } from "./database.js";
import type { AttachmentService } from "./attachment-service.js";
import type { CreateTaskInput, TaskService } from "./task-service.js";

export interface TaskCreationInput extends CreateTaskInput {
  draftId?: string;
  attachmentIds?: string[];
}

interface DraftRow { device_id: string; state: string; task_id: string | null; request_json: string | null }

export class TaskCreationService {
  constructor(private readonly database: AppDatabase, private readonly tasks: TaskService, private readonly attachments: AttachmentService) {}

  private draft(id: string, deviceId: string): DraftRow {
    assertDomain(typeof id === "string" && /^[0-9a-f-]{36}$/.test(id), "Invalid task draft", "invalid_task_draft");
    this.database.db.prepare("INSERT OR IGNORE INTO task_creation_drafts (id, device_id, created_at) VALUES (?, ?, ?)")
      .run(id, deviceId, new Date().toISOString());
    const draft = this.database.db.prepare("SELECT * FROM task_creation_drafts WHERE id = ?").get(id) as DraftRow;
    assertDomain(draft.device_id === deviceId, "Task draft belongs to another device", "draft_forbidden", 403);
    return draft;
  }

  initiate(id: string, deviceId: string, input: { filename?: unknown; mediaType?: unknown; size?: unknown }) {
    assertDomain(this.draft(id, deviceId).state === "active", "Task draft is no longer active", "draft_not_active", 409);
    return this.attachments.initiate("task", `draft:${id}`, deviceId, input);
  }

  cancel(id: string, deviceId: string): void {
    const draft = this.draft(id, deviceId);
    assertDomain(draft.state !== "created", "This task was already created. Retry saving to recover it.", "draft_already_created", 409);
    // Tombstone first so a delayed upload initiation cannot recreate the draft.
    this.database.db.prepare("UPDATE task_creation_drafts SET state = 'cancelled' WHERE id = ?").run(id);
    this.attachments.removeDraftUploads(id, deviceId);
  }

  create(input: TaskCreationInput, deviceId: string) {
    const ids = input.attachmentIds ?? [];
    assertDomain(Array.isArray(ids) && ids.every(id => typeof id === "string"), "Invalid attachment identifiers", "invalid_attachments");
    if (input.draftId === undefined) {
      assertDomain(ids.length === 0, "A task draft is required for attachments", "invalid_task_draft");
      return this.tasks.createTask(input, "user");
    }
    const { draftId } = input;
    const requestJson = JSON.stringify([input.projectId, input.title ?? null, input.description ?? null, input.sections ?? null, input.status ?? "backlog", ids]);
    const task = this.database.db.transaction(() => {
      const draft = this.draft(draftId, deviceId);
      if (draft.state === "created") {
        assertDomain(draft.request_json === requestJson, "This draft was already saved with different content", "draft_conflict", 409);
        return this.tasks.getTask(draft.task_id!);
      }
      assertDomain(draft.state === "active", "Task draft was cancelled", "draft_not_active", 409);
      this.attachments.prepareForMessage("task", `draft:${draftId}`, deviceId, ids);
      const created = this.tasks.createTask(input, "user");
      if (ids.length) {
        const messageId = randomUUID();
        this.database.db.prepare(`INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at)
          VALUES (?, 'task', ?, 'user', 'Files attached when this task was created.', ?)`)
          .run(messageId, created.id, new Date().toISOString());
        const attachments = this.attachments.bindToCreatedTask(ids, created.id, messageId);
        this.database.db.prepare("UPDATE chat_messages SET metadata_json = ? WHERE id = ?")
          .run(JSON.stringify({ attachments, taskCreation: true }), messageId);
      }
      this.database.db.prepare("UPDATE task_creation_drafts SET state = 'created', task_id = ?, request_json = ? WHERE id = ?")
        .run(created.id, requestJson, draftId);
      return created;
    })();
    // Discard removed/unselected uploads only after the task transaction commits.
    this.attachments.removeDraftUploads(draftId, deviceId);
    return task;
  }
}
