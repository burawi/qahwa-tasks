import { createHash } from "node:crypto";
import type { TaskWorkspace, WorkspaceCursor, WorkspacePoll } from "../domain/types.js";

const revisionOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Hash the decorated history too: edits, resets and expired attachments must invalidate it. */
export function workspacePoll(workspace: TaskWorkspace, cursor: WorkspaceCursor): WorkspacePoll {
  const { messages, ...rest } = workspace;
  const messagesRevision = revisionOf(messages);
  const revision = revisionOf({ ...rest, messagesRevision });
  return {
    revision,
    messagesRevision,
    workspace: cursor.revision === revision ? null : cursor.messagesRevision === messagesRevision ? rest : workspace,
  };
}
