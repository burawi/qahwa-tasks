export const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskOutcome = "completed" | "cancelled" | null;
export type Actor = "user" | "codex" | "system";
export type CommentKind = "comment" | "handoff";
export type TaskTone = "neutral" | "blue" | "green" | "orange" | "red";
export type SessionSurface = "undecided" | "chat" | "design";
export type SessionRunState = "not_started" | "idle" | "running" | "waiting" | "failed" | "interrupted";
export type SessionOwnerType = "task" | "orchestrator";
export type TaskIntakeState = "pending" | "ready";
export type TaskAccessMode = "read-only" | "worktree-write";

export interface ChatAttachment {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  status: "available" | "expired";
  previewUrl: string;
}

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
  /** Missing on older clients/fixtures means Codex. */
  sessionKind?: "codex" | "terminal";
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
  /** Presentation preference; never changes task priority or scheduling. */
  pinnedAt?: string | null;
  conversation?: {
    /** Plain description text for list search; excludes conversation messages. */
    descriptionText?: string;
    activityAt: string;
    latestMessage: { preview: string; role: "user" | "assistant"; createdAt: string } | null;
    unreadCount: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SelectedTaskReference {
  id: string;
  humanId: string;
  title: string;
}

export interface ChatExcerpt {
  messageId: string;
  excerpt: string;
  role: "user" | "assistant" | "system";
}

export interface GuidanceDelivery {
  messageId: string;
  taskId: string;
  taskTitle: string;
  status: "saved" | "pending" | "delivered" | "failed";
  detail: string;
  uncertain: boolean;
  expectedTurnId: string | null;
  turnId: string | null;
}

export interface ChatMessage {
  id: string;
  ownerType: SessionOwnerType;
  ownerId: string;
  role: "user" | "assistant" | "system";
  body: string;
  itemId: string | null;
  metadata: (Record<string, unknown> & { attachments?: ChatAttachment[]; files?: TaskArtifact[]; selectedTasks?: SelectedTaskReference[]; designPageId?: string | null; selectedExcerpt?: ChatExcerpt }) | null;
  createdAt: string;
  pending?: boolean;
  cancelledAt?: string | null;
  canCancel?: boolean;
  canEdit?: boolean;
  canRunNow?: boolean;
  version?: number;
  editedAt?: string | null;
  schedule?: MessageSchedule | null;
  guidanceDeliveries?: GuidanceDelivery[];
}

export interface ChatReadState {
  unreadMessageIds: string[];
  unreadCount: number;
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
  intakeState: TaskIntakeState;
  /** Requested mode for the next turn; missing on older clients means exclusive editing. */
  accessMode?: TaskAccessMode;
  /** Immutable grant held by a running/waiting/starting turn. */
  activeAccessMode?: TaskAccessMode;
  activeAccessVersion?: number;
  accessVersion?: number;
  accessReason?: string | null;
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

export interface DesignPage {
  id: string;
  name: string;
  document: DesignDocument;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkActivity {
  id: string;
  kind: "thinking" | "command" | "edit" | "tool" | "search" | "error";
  title: string;
  detail: string | null;
  context: string | null;
  status: "running" | "done" | "error";
  startedAt: string;
  updatedAt: string;
}

export interface TaskSchedule {
  taskId: string;
  version: number;
  localTime: string;
  timezone: string;
  runAt: string;
  policy: "when_available" | "skip_if_missed";
  state: "pending" | "reserved" | "started" | "skipped" | "cancelled" | "interrupted";
  updatedAt: string;
  reason: string | null;
}

export interface MessageSchedule extends Omit<TaskSchedule, "state"> {
  messageId: string;
  state: "pending" | "reserved" | "delivered" | "skipped" | "cancelled" | "interrupted";
}

export interface TaskWorkspace {
  modelSettings?: import("./chat-model.js").ChatModelSettings;
  hasPendingMessages?: boolean;
  canScheduleFollowup?: boolean;
  schedule?: TaskSchedule | null;
  session: AgentSession;
  messages: ChatMessage[];
  history?: MessageHistoryPage;
  pendingRequests: PendingRequest[];
  design: { document: DesignDocument; revision: number; updatedAt: string } | null;
  designPages: DesignPage[];
  selectedDesignPageId: string | null;
  recentEvents: Array<{ type: string; createdAt: string }>;
  workActivities: WorkActivity[];
}

export interface MessageHistoryPage {
  oldestCursor: string | null;
  hasOlder: boolean;
}

export interface MessagePage extends MessageHistoryPage {
  messages: ChatMessage[];
}

export interface MessagePageQuery {
  before?: string;
  /** Inclusive oldest boundary when reconciling already loaded history. */
  through?: string;
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
  canEdit?: boolean;
  idleNotificationsEnabled: boolean;
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

export type ArtifactPreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "none";
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

/** Conditional polling uses the same authenticated, encrypted request transport. */
export interface WorkspaceCursor {
  revision?: string;
  messagesRevision?: string;
}

export interface TerminalView {
  closed: boolean;
  messages: ChatMessage[];
  screenText: string;
  alternateScreen: boolean;
  atPrompt: boolean;
  generation: string;
  state: "running" | "exited" | "interrupted" | "failed";
  cols: number;
  rows: number;
  cursor: number;
  /** Serialized screen including scrollback and alternate screen on resync. */
  reset: boolean;
  data: string;
  exitCode: number | null;
  error: string | null;
}
export type WorkspaceUpdate = Omit<TaskWorkspace, "messages"> & { messages?: ChatMessage[] };
export interface WorkspacePoll {
  workspace: WorkspaceUpdate | null;
  revision: string;
  messagesRevision: string;
}
