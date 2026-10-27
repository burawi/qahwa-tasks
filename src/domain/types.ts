export const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskOutcome = "completed" | "cancelled" | null;
export type Actor = "user" | "codex" | "system";
export type CommentKind = "comment" | "handoff";
export type TaskTone = "neutral" | "blue" | "green" | "orange" | "red";
export type SessionSurface = "undecided" | "chat" | "design";
export type SessionRunState = "not_started" | "idle" | "running" | "waiting" | "failed" | "interrupted";
export type SessionOwnerType = "task" | "orchestrator";

export interface RichTextNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: RichTextNode[];
}

export interface RichTextDocument extends RichTextNode {
  type: "doc";
  content?: RichTextNode[];
}

export interface Project {
  id: string;
  name: string;
  prefix: string;
  rootDirectory: string;
  logo: ProjectLogo | null;
  archivedAt: string | null;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLogo {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  updatedAt: string;
  url: string;
}

export interface TaskSummary {
  id: string;
  humanId: string;
  projectId: string;
  projectName: string;
  projectPrefix: string;
  projectLogo: ProjectLogo | null;
  title: string;
  status: TaskStatus;
  outcome: TaskOutcome;
  rank: number;
  unresolvedCommentCount: number;
  version: number;
  smartMessage: string;
  tone: TaskTone;
  sessionState: SessionRunState;
  surface: SessionSurface;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  ownerType: SessionOwnerType;
  ownerId: string;
  role: "user" | "assistant" | "system";
  body: string;
  itemId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  ownerType: SessionOwnerType;
  ownerId: string;
  threadId: string | null;
  activeTurnId: string | null;
  surface: SessionSurface;
  runState: SessionRunState;
  generation: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingRequest {
  id: string;
  ownerType: SessionOwnerType;
  ownerId: string;
  requestType: "command" | "file_change" | "user_input" | "permissions" | "other";
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "answered" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

export interface DesignDocument {
  format: "web";
  artboard: { width: number; height: number; background: string; name: string };
  html: string;
  css: string;
}

export interface TaskWorkspace {
  session: AgentSession;
  messages: ChatMessage[];
  pendingRequests: PendingRequest[];
  design: { document: DesignDocument; revision: number; updatedAt: string } | null;
  designVersions: Array<{ id: string; name: string; document: DesignDocument; revision: number; createdAt: string }>;
}

export interface RelatedTask {
  id: string;
  humanId: string;
  projectId: string;
  projectName: string;
  projectPrefix: string;
  title: string;
  status: TaskStatus;
  outcome: TaskOutcome;
}

export interface TaskComment {
  id: string;
  taskId: string;
  parentId: string | null;
  author: Actor;
  kind: CommentKind;
  body: RichTextDocument;
  plainText: string;
  requiresResponse: boolean;
  resolvedAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  replies: TaskComment[];
}

export interface TaskOutput {
  id: string;
  taskId: string;
  summary: string;
  validation: string[];
  commit: string | null;
  limitations: string[];
  sessionId: string | null;
  runId: string | null;
  artifacts: TaskArtifact[];
  commitApproval: CommitApproval | null;
  sourceCommentId: string | null;
  createdAt: string;
}

export interface TaskDetail extends TaskSummary {
  rootDirectory: string;
  description: RichTextDocument;
  comments: TaskComment[];
  outputs: TaskOutput[];
  latestHandoff: TaskComment | null;
  relatedTasks: RelatedTask[];
}

export interface HandoffInput {
  sessionId?: string;
  runId?: string;
  summary: string;
  validation?: string[];
  commit?: string;
  limitations?: string[];
  artifacts?: ArtifactReference[];
  commitProposal?: CommitProposal;
}

export interface CommitProposal {
  message: string;
  repositoryRoot: string;
  baseRevision: string;
  files: string[];
  releaseNote: string;
}

export interface CommitApproval extends CommitProposal {
  status: "pending" | "committed";
  commitHash: string | null;
}

export type ArtifactReference = string | {
  path?: string;
  url?: string;
  filename?: string;
  mediaType?: string;
  size?: number;
};

export type ArtifactPreviewKind = "image" | "video" | "pdf" | "none";
export type ArtifactAvailability = "available" | "external" | "missing" | "unsupported" | "too_large" | "outside_scope";

export interface TaskArtifact {
  source: string;
  sourceType: "path" | "url";
  filename: string;
  mediaType: string | null;
  size: number | null;
  previewKind: ArtifactPreviewKind;
  availability: ArtifactAvailability;
  previewUrl: string | null;
}

export const emptyDocument = (): RichTextDocument => ({ type: "doc", content: [{ type: "paragraph" }] });

export function plainTextFromDocument(document: RichTextDocument): string {
  const pieces: string[] = [];
  const visit = (node: RichTextNode): void => {
    if (node.text) pieces.push(node.text);
    node.content?.forEach(visit);
    if (["paragraph", "heading", "listItem", "taskItem"].includes(node.type ?? "")) pieces.push("\n");
  };
  visit(document);
  return pieces.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function documentFromPlainText(text: string): RichTextDocument {
  const paragraphs = text.trim().split(/\n{2,}/).filter(Boolean);
  return {
    type: "doc",
    content: (paragraphs.length ? paragraphs : [""]).map((paragraph) => ({
      type: "paragraph",
      content: paragraph ? [{ type: "text", text: paragraph }] : undefined,
    })),
  };
}

export function documentFromSections(sections: Array<{ heading: string; body: string | string[] }>): RichTextDocument {
  const content: RichTextNode[] = [];
  for (const section of sections) {
    const values = Array.isArray(section.body) ? section.body.filter(Boolean) : [section.body].filter(Boolean);
    if (!values.length) continue;
    content.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: section.heading }] });
    if (Array.isArray(section.body)) {
      content.push({
        type: section.heading.toLowerCase() === "done when" ? "taskList" : "bulletList",
        content: values.map((value) => ({
          type: section.heading.toLowerCase() === "done when" ? "taskItem" : "listItem",
          attrs: section.heading.toLowerCase() === "done when" ? { checked: false } : undefined,
          content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
        })),
      });
    } else {
      content.push({ type: "paragraph", content: [{ type: "text", text: values[0] }] });
    }
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
