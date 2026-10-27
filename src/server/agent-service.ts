import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpus, freemem, totalmem } from "node:os";
import readline from "node:readline";
import { DomainError, assertDomain } from "../domain/errors.js";
import {
  plainTextFromDocument,
  type AgentSession,
  type ChatMessage,
  type DesignDocument,
  type PendingRequest,
  type SessionOwnerType,
  type SessionRunState,
  type SessionSurface,
  type TaskTone,
  type TaskWorkspace,
} from "../domain/types.js";
import type { AppDatabase } from "./database.js";
import type { TaskService } from "./task-service.js";

type JsonObject = Record<string, unknown>;
type Owner = { ownerType: SessionOwnerType; ownerId: string };
type RpcPending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

interface SessionRow {
  id: string; owner_type: SessionOwnerType; owner_id: string; thread_id: string | null; active_turn_id: string | null;
  surface: SessionSurface; run_state: SessionRunState; generation: number; last_error: string | null;
  created_at: string; updated_at: string;
}

interface MessageRow {
  id: string; owner_type: SessionOwnerType; owner_id: string; role: ChatMessage["role"]; body: string;
  codex_item_id: string | null; metadata_json: string | null; created_at: string;
}

interface RequestRow {
  id: string; owner_type: SessionOwnerType; owner_id: string; request_type: PendingRequest["requestType"];
  payload_json: string; status: PendingRequest["status"]; created_at: string; resolved_at: string | null;
}

export interface CapacitySnapshot {
  logicalCpus: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  activeTurns: number;
  recommendedParallelism: number;
  availableSlots: number;
}

const isoNow = (): string => new Date().toISOString();

export function isolatedCodexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ORCA_") || key.startsWith("JCODE_") || key === "INVOCATION_ID"
      || key === "CODEX_THREAD_ID" || key === "CODEX_SESSION_ID" || key === "CODEX_TOOL_CALL_ID") {
      delete environment[key];
    }
  }
  return environment;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function safeDesign(document: DesignDocument): boolean {
  const source = `${document.html}\n${document.css}`;
  return document.html.length <= 500_000 && document.css.length <= 500_000
    && !/<\s*(script|iframe|object|embed|form|link|meta)\b/i.test(document.html)
    && !/\son[a-z]+\s*=/i.test(document.html)
    && !/(?:javascript|data\s*:\s*text\/html)\s*:/i.test(source)
    && !/@import\b/i.test(document.css);
}

function sessionFromRow(row: SessionRow): AgentSession {
  return {
    id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, threadId: row.thread_id,
    activeTurnId: row.active_turn_id, surface: row.surface, runState: row.run_state,
    generation: row.generation, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, role: row.role, body: row.body,
    itemId: row.codex_item_id, metadata: row.metadata_json ? object(JSON.parse(row.metadata_json)) : null,
    createdAt: row.created_at,
  };
}

function requestFromRow(row: RequestRow): PendingRequest {
  return {
    id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, requestType: row.request_type,
    payload: object(JSON.parse(row.payload_json)), status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at,
  };
}

export function recommendedParallelism(logicalCpus = cpus().length, freeBytes = freemem(), totalBytes = totalmem()): number {
  const memoryGiB = freeBytes / 1024 ** 3;
  const memoryPressure = totalBytes > 0 && freeBytes / totalBytes < 0.18;
  if (logicalCpus <= 2 || memoryGiB < 1.5 || memoryPressure) return 1;
  if (logicalCpus <= 6 || memoryGiB < 6) return 2;
  return Math.min(4, Math.max(2, Math.floor(logicalCpus / 3)));
}

export function parseAgentEnvelope(text: string): {
  body: string; message?: string; tone?: TaskTone; surface?: SessionSurface; design?: DesignDocument; review: boolean; startTasks: string[]; priorityTasks: string[];
} {
  let body = text.trim();
  let message: string | undefined;
  let tone: TaskTone | undefined;
  let surface: SessionSurface | undefined;
  let design: DesignDocument | undefined;
  let review = false;
  const startTasks: string[] = [];
  const priorityTasks: string[] = [];
  const metadata = /<!--\s*qahwa:(\{[\s\S]*?\})\s*-->/i.exec(body);
  if (metadata) {
    try {
      const parsed = object(JSON.parse(metadata[1]!));
      if (typeof parsed.message === "string") message = parsed.message.slice(0, 100);
      if (["neutral", "blue", "green", "orange", "red"].includes(String(parsed.tone))) tone = parsed.tone as TaskTone;
      if (["undecided", "chat", "design"].includes(String(parsed.surface))) surface = parsed.surface as SessionSurface;
      review = parsed.review === true;
    } catch { /* malformed optional envelope is displayed as ordinary text */ }
    body = body.replace(metadata[0], "").trim();
  }
  const designMatch = /<qahwa-design>\s*([\s\S]*?)\s*<\/qahwa-design>/i.exec(body);
  if (designMatch) {
    try {
      const candidate = object(JSON.parse(designMatch[1]!));
      const artboard = object(candidate.artboard);
      if (candidate.format === "web" && typeof candidate.html === "string" && typeof candidate.css === "string"
        && typeof artboard.width === "number" && typeof artboard.height === "number"
        && typeof artboard.background === "string" && typeof artboard.name === "string") {
        const proposed = candidate as unknown as DesignDocument;
        if (safeDesign(proposed)) {
          design = proposed;
          surface = "design";
          body = body.replace(designMatch[0], "").trim();
        }
      }
    } catch { /* invalid design remains visible for diagnosis */ }
  }
  body = body.replace(/<!--\s*qahwa-start:([A-Z0-9-]+)\s*-->/gi, (_match, id: string) => {
    startTasks.push(id);
    return "";
  }).trim();
  body = body.replace(/<!--\s*qahwa-priority:([A-Z0-9,\s-]+)\s*-->/gi, (_match, ids: string) => {
    for (const id of ids.split(",").map((value) => value.trim()).filter(Boolean)) if (!priorityTasks.includes(id)) priorityTasks.push(id);
    return "";
  }).trim();
  return { body, message, tone, surface, design, review, startTasks, priorityTasks };
}

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, RpcPending>();

  constructor(private readonly onMessage: (message: JsonObject) => void) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      clientInfo: { name: "qahwa-tasks", title: "Qahwa Tasks", version: "2.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  async request(method: string, params: JsonObject): Promise<any> {
    this.start();
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  notify(method: string, params: JsonObject): void {
    this.start();
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.initialized = false;
  }

  private start(): void {
    if (this.child) return;
    this.child = spawn("codex", ["app-server", "-c", "mcp_servers={}"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: isolatedCodexEnvironment(),
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      try { this.handle(JSON.parse(line) as JsonObject); } catch { /* app-server may emit a partial diagnostic */ }
    });
    this.child.stderr.on("data", (chunk) => this.onMessage({ method: "qahwa/log", params: { text: String(chunk) } }));
    this.child.on("exit", () => {
      this.child = null;
      this.initialized = false;
      for (const pending of this.pending.values()) pending.reject(new Error("Codex App Server stopped"));
      this.pending.clear();
    });
  }

  private handle(message: JsonObject): void {
    const id = message.id;
    if (typeof id === "number" && !message.method && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      const error = object(message.error);
      if (Object.keys(error).length) pending.reject(new Error(String(error.message ?? "Codex request failed")));
      else pending.resolve(message.result);
      return;
    }
    this.onMessage(message);
  }

  private write(message: JsonObject): void {
    assertDomain(this.child?.stdin.writable, "Codex App Server is unavailable", "codex_unavailable", 503);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

export class AgentService {
  private readonly codex: CodexAppServer;
  private readonly threadOwners = new Map<string, Owner>();
  private readonly turnOwners = new Map<string, Owner>();
  private pendingOrchestratorStarts: string[] = [];
  private orchestratorStartAuthorized = false;
  private orchestratorPriorityAuthorized = false;
  private readonly orchestratorObservations: string[] = [];

  constructor(private readonly database: AppDatabase, private readonly tasks: TaskService) {
    this.codex = new CodexAppServer((message) => this.handleCodexMessage(message));
    const restartedAt = isoNow();
    this.database.db.prepare("UPDATE pending_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending'").run(restartedAt);
    this.database.db.prepare(`
      UPDATE agent_sessions SET run_state = 'interrupted', active_turn_id = NULL,
        last_error = 'Backend restarted during the active turn', updated_at = ?
      WHERE run_state IN ('running','waiting')
    `).run(restartedAt);
    const rows = this.database.db.prepare("SELECT thread_id, owner_type, owner_id FROM agent_sessions WHERE thread_id IS NOT NULL")
      .all() as Array<{ thread_id: string; owner_type: SessionOwnerType; owner_id: string }>;
    for (const row of rows) this.threadOwners.set(row.thread_id, { ownerType: row.owner_type, ownerId: row.owner_id });
  }

  capacity(): CapacitySnapshot {
    const logicalCpus = cpus().length;
    const freeMemoryBytes = freemem();
    const totalMemoryBytes = totalmem();
    const activeTurns = Number((this.database.db.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE run_state = 'running'").get() as { count: number }).count);
    const parallelism = recommendedParallelism(logicalCpus, freeMemoryBytes, totalMemoryBytes);
    return { logicalCpus, freeMemoryBytes, totalMemoryBytes, activeTurns, recommendedParallelism: parallelism, availableSlots: Math.max(0, parallelism - activeTurns) };
  }

  workspace(ownerType: SessionOwnerType, ownerId: string): TaskWorkspace {
    const session = this.ensureSession(ownerType, ownerId);
    const messages = (this.database.db.prepare(`
      SELECT * FROM chat_messages WHERE owner_type = ? AND owner_id = ? ORDER BY created_at, rowid
    `).all(ownerType, ownerId) as MessageRow[]).map(messageFromRow);
    const pendingRequests = (this.database.db.prepare(`
      SELECT * FROM pending_requests WHERE owner_type = ? AND owner_id = ? AND status = 'pending' ORDER BY created_at
    `).all(ownerType, ownerId) as RequestRow[]).map(requestFromRow);
    const designRow = ownerType === "task" ? this.database.db.prepare("SELECT * FROM design_documents WHERE task_id = ?").get(ownerId) as
      | { document_json: string; revision: number; updated_at: string } | undefined : undefined;
    const designVersions = ownerType === "task" ? (this.database.db.prepare(`
      SELECT id, name, document_json, revision, created_at FROM design_versions WHERE task_id = ? ORDER BY created_at DESC
    `).all(ownerId) as Array<{ id: string; name: string; document_json: string; revision: number; created_at: string }>).map((row) => ({
      id: row.id, name: row.name, document: JSON.parse(row.document_json) as DesignDocument,
      revision: row.revision, createdAt: row.created_at,
    })) : [];
    return {
      session, messages, pendingRequests,
      design: designRow ? { document: JSON.parse(designRow.document_json) as DesignDocument, revision: designRow.revision, updatedAt: designRow.updated_at } : null,
      designVersions,
    };
  }

  async triggerTask(taskId: string, actor: "user" | "orchestrator" = "user"): Promise<TaskWorkspace> {
    const task = this.tasks.getTask(taskId);
    const session = this.ensureSession("task", task.id);
    assertDomain(session.runState !== "running", "This task is already running", "task_running", 409);
    const capacity = this.capacity();
    assertDomain(capacity.availableSlots > 0, "The computer is at its safe parallel-work limit", "capacity_full", 409);
    if (task.status === "closed") throw new DomainError("Closed tasks cannot be started", "task_closed", 409);
    if (task.status === "backlog") this.tasks.transition(task.id, { to: "todo" }, actor === "user" ? "user" : "system");
    const current = this.tasks.getTask(task.id);
    if (current.status === "todo") this.tasks.transition(task.id, { to: "in_progress" }, "codex");
    this.database.db.prepare(`
      INSERT INTO scheduler_runs (id, task_id, actor, decision, reason, capacity_json, created_at)
      VALUES (?, ?, ?, 'started', ?, ?, ?)
    `).run(randomUUID(), task.id, actor, actor === "orchestrator" ? "Authorized by the user through the orchestrator" : "Triggered directly by the user", JSON.stringify(capacity), isoNow());
    const note = plainTextFromDocument(task.description) || task.title;
    await this.send("task", task.id, note, true);
    return this.workspace("task", task.id);
  }

  async send(ownerType: SessionOwnerType, ownerId: string, body: string, initial = false, messageRole: ChatMessage["role"] = "user"): Promise<TaskWorkspace> {
    const text = body.trim();
    assertDomain(text.length > 0 && text.length <= 30_000, "Message must be 1–30,000 characters", "invalid_message");
    const session = this.ensureSession(ownerType, ownerId);
    assertDomain(session.runState !== "running", "This session is already working", "session_running", 409);
    assertDomain(this.capacity().availableSlots > 0, "The computer is at its safe parallel-work limit", "capacity_full", 409);
    if (ownerType === "task") {
      const task = this.tasks.getTask(ownerId);
      assertDomain(task.status !== "closed", "Closed tasks cannot receive new work", "task_closed", 409);
      if (task.status === "in_review") this.tasks.transition(task.id, { to: "in_progress" }, "codex");
    } else {
      this.orchestratorStartAuthorized = messageRole === "user" && (
        /\b(start|run|trigger|launch|execute)\b[\s\S]{0,100}\b[A-Z]{2,10}-\d{4}\b/i.test(text)
        || /\b(start|run|trigger|launch|execute)\b[\s\S]{0,80}\b(tasks?|work)\b/i.test(text)
        || /\b(you decide|use your judgment)\b[\s\S]{0,80}\b(start|run|tasks?|work)\b/i.test(text)
      );
      this.orchestratorPriorityAuthorized = messageRole === "user" && /\b(prioriti[sz]e|priority|reorder|order)\b/i.test(text);
    }
    this.addMessage(ownerType, ownerId, messageRole, text);
    this.updateSession(ownerType, ownerId, { runState: "running", lastError: null });
    if (ownerType === "task") this.setPresence(ownerId, "Working", "blue", "A Codex turn is active");
    try {
      await this.codex.initialize();
      const cwd = ownerType === "task" ? this.tasks.getTask(ownerId).rootDirectory : process.cwd();
      let threadId = session.threadId;
      if (threadId) {
        try { await this.codex.request("thread/resume", { threadId }); }
        catch { threadId = null; }
      }
      if (!threadId) {
        const started = object(await this.codex.request("thread/start", {
          cwd, approvalPolicy: "on-request", sandbox: ownerType === "orchestrator" ? "read-only" : "workspace-write", ephemeral: false,
        }));
        threadId = String(object(started.thread).id ?? started.threadId ?? "");
        assertDomain(threadId, "Codex did not create a thread", "codex_thread_failed", 503);
        this.threadOwners.set(threadId, { ownerType, ownerId });
        this.updateSession(ownerType, ownerId, { threadId });
      }
      const prompt = this.prompt(ownerType, ownerId, text, initial);
      const startedTurn = object(await this.codex.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] }));
      const turnId = String(object(startedTurn.turn).id ?? startedTurn.turnId ?? "");
      assertDomain(turnId, "Codex did not create a turn", "codex_turn_failed", 503);
      this.turnOwners.set(turnId, { ownerType, ownerId });
      this.updateSession(ownerType, ownerId, { activeTurnId: turnId, runState: "running" });
      this.recordEvent({ ownerType, ownerId }, "turn.started", { threadId, turnId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.updateSession(ownerType, ownerId, { runState: "failed", activeTurnId: null, lastError: reason });
      if (ownerType === "task") this.setPresence(ownerId, "Could not start", "red", reason);
      throw error;
    }
    return this.workspace(ownerType, ownerId);
  }

  async interrupt(ownerType: SessionOwnerType, ownerId: string): Promise<TaskWorkspace> {
    const session = this.ensureSession(ownerType, ownerId);
    assertDomain(session.threadId && session.activeTurnId, "There is no active turn", "no_active_turn", 409);
    await this.codex.initialize();
    await this.codex.request("turn/interrupt", { threadId: session.threadId, turnId: session.activeTurnId });
    this.updateSession(ownerType, ownerId, { runState: "interrupted", activeTurnId: null });
    if (ownerType === "task") this.setPresence(ownerId, "Paused", "orange", "The user interrupted the active turn");
    return this.workspace(ownerType, ownerId);
  }

  async resolveRequest(requestId: string, response: { approved?: boolean; answers?: Record<string, string> }): Promise<void> {
    const row = this.database.db.prepare("SELECT * FROM pending_requests WHERE id = ? AND status = 'pending'").get(requestId) as
      | (RequestRow & { rpc_request_id: string | null }) | undefined;
    assertDomain(row?.rpc_request_id, "Pending request not found", "request_not_found", 404);
    const rpcId = JSON.parse(row.rpc_request_id) as string | number;
    let result: unknown;
    if (row.request_type === "user_input") result = {
      answers: Object.fromEntries(Object.entries(response.answers ?? {}).map(([id, answer]) => [id, { answers: [answer] }])),
    };
    else if (row.request_type === "permissions") {
      const payload = object(JSON.parse(row.payload_json));
      result = { permissions: response.approved ? object(payload.permissions) : {}, scope: "turn" };
    } else result = { decision: response.approved ? "approved" : { denied: { rejection: "Denied by the user" } } };
    this.codex.respond(rpcId, result);
    this.database.db.prepare("UPDATE pending_requests SET status = ?, resolved_at = ? WHERE id = ?")
      .run(row.request_type === "user_input" ? "answered" : response.approved ? "approved" : "denied", isoNow(), row.id);
    this.updateSession(row.owner_type, row.owner_id, { runState: "running" });
  }

  async cleanOrchestrator(): Promise<TaskWorkspace> {
    const session = this.ensureSession("orchestrator", "main");
    assertDomain(session.runState !== "running", "Interrupt the orchestrator before cleaning it", "session_running", 409);
    if (session.threadId) {
      await this.codex.initialize();
      try { await this.codex.request("thread/archive", { threadId: session.threadId }); } catch { /* preserve local reset */ }
      this.threadOwners.delete(session.threadId);
    }
    const timestamp = isoNow();
    this.database.db.prepare(`
      UPDATE pending_requests SET status = 'expired', resolved_at = ? WHERE owner_type = 'orchestrator' AND owner_id = 'main' AND status = 'pending'
    `).run(timestamp);
    this.database.db.prepare(`
      UPDATE agent_sessions SET thread_id = NULL, active_turn_id = NULL, run_state = 'not_started', surface = 'chat',
      generation = generation + 1, last_error = NULL, updated_at = ? WHERE owner_type = 'orchestrator' AND owner_id = 'main'
    `).run(timestamp);
    this.database.db.prepare("DELETE FROM chat_messages WHERE owner_type = 'orchestrator' AND owner_id = 'main'").run();
    this.database.db.prepare("DELETE FROM session_events WHERE owner_type = 'orchestrator' AND owner_id = 'main'").run();
    return this.workspace("orchestrator", "main");
  }

  close(): void { this.codex.close(); }

  private ensureSession(ownerType: SessionOwnerType, ownerId: string): AgentSession {
    if (ownerType === "task") this.tasks.getTask(ownerId);
    const existing = this.database.db.prepare("SELECT * FROM agent_sessions WHERE owner_type = ? AND owner_id = ?")
      .get(ownerType, ownerId) as SessionRow | undefined;
    if (existing) return sessionFromRow(existing);
    const timestamp = isoNow();
    this.database.db.prepare(`
      INSERT INTO agent_sessions (id, owner_type, owner_id, surface, run_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'not_started', ?, ?)
    `).run(randomUUID(), ownerType, ownerId, ownerType === "orchestrator" ? "chat" : "undecided", timestamp, timestamp);
    return sessionFromRow(this.database.db.prepare("SELECT * FROM agent_sessions WHERE owner_type = ? AND owner_id = ?")
      .get(ownerType, ownerId) as SessionRow);
  }

  private prompt(ownerType: SessionOwnerType, ownerId: string, userText: string, initial: boolean): string {
    const envelope = `At the end of every response, append exactly one hidden marker: <!-- qahwa:{"message":"short task-list status under 7 words","tone":"neutral|blue|green|orange|red","surface":"chat|design","review":false} -->. Use green for a good completed/result state, red for failure/blocker, orange for warning or clarification needed, blue for active progress, neutral for dormant context. Set review true only when implementation and proportionate validation are complete and the task is genuinely ready for user review. Never claim completion without evidence.`;
    if (ownerType === "orchestrator") {
      const tasks = this.tasks.listTasks({ tab: "active" }).map((task) => ({
        id: task.humanId, project: task.projectName, title: task.title, status: task.status,
        session: task.sessionState, message: task.smartMessage, tone: task.tone,
      }));
      const capacity = this.capacity();
      return `You are Qahwa's single orchestration session. Collaborate with the user on priorities and watch the task portfolio without micromanaging task agents. Be proactive only when something materially changes, needs a decision, is blocked, or capacity becomes useful. You may recommend concurrent work using this capacity snapshot: ${JSON.stringify(capacity)}. To actually trigger an authorized task, append <!-- qahwa-start:HUMAN-ID --> for each task. To apply a user-authorized priority order, append one <!-- qahwa-priority:ID-0001,ID-0002 --> marker listing highest priority first. Never start or reorder merely because a task exists; only do so when the user has authorized that action in this conversation. Current active task projection: ${JSON.stringify(tasks)}. ${envelope}\n\nUser: ${userText}`;
    }
    const task = this.tasks.getTask(ownerId);
    const workspace = this.workspace("task", ownerId);
    const design = workspace.design?.document;
    const designRule = `Decide whether this work is best served by normal chat or a visual design canvas. For a design canvas, set surface to design and include the complete document as JSON inside <qahwa-design>...</qahwa-design>. The document shape is {"format":"web","artboard":{"width":number,"height":number,"background":"color","name":"name"},"html":"...","css":"..."}. Every meaningful element needs a unique data-qahwa-id. No scripts, iframes, external stylesheets, event handlers, or form submission. The chat remains available alongside a design. Current design: ${design ? JSON.stringify(design) : "none"}.`;
    return `You are the persistent Codex worker for ${task.humanId} in ${task.projectName}. Work directly in ${task.rootDirectory}. The task started as an on-the-fly note and may need clarification before implementation. Ask concise questions when requirements materially affect the result. You may inspect and edit files and run safe validation. Do not commit, push, deploy, publish, close the task, or perform destructive/external actions without explicit user authorization in this task chat. ${designRule} ${envelope}\n\n${initial ? "Initial task note" : "User"}: ${userText}`;
  }

  private handleCodexMessage(message: JsonObject): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params = object(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : typeof object(params.thread).id === "string" ? String(object(params.thread).id) : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof object(params.turn).id === "string" ? String(object(params.turn).id) : null;
    const owner = (turnId && this.turnOwners.get(turnId)) || (threadId && this.threadOwners.get(threadId)) || this.ownerFromIds(threadId, turnId);
    if (!owner) return;
    this.recordEvent(owner, method || "rpc.request", { threadId, turnId, payload: params });
    if (message.id !== undefined && method) {
      this.storePending(owner, message.id as string | number, method, params);
      return;
    }
    if (method === "item/completed") {
      const item = object(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string" && (item.phase === "final_answer" || !item.phase)) {
        this.finishAgentMessage(owner, String(item.id ?? randomUUID()), item.text);
      }
    }
    if (method === "turn/completed") {
      const turn = object(params.turn);
      const status = String(turn.status ?? "completed");
      const state: SessionRunState = status === "completed" ? "idle" : status === "interrupted" ? "interrupted" : "failed";
      this.updateSession(owner.ownerType, owner.ownerId, { runState: state, activeTurnId: null, lastError: state === "failed" ? status : null });
      if (turnId) this.turnOwners.delete(turnId);
      if (owner.ownerType === "task" && state === "failed") {
        this.setPresence(owner.ownerId, "Run failed", "red", status);
        const task = this.tasks.getTask(owner.ownerId);
        this.addMessage("orchestrator", "main", "system", `${task.humanId} · run failed`, { taskId: task.id, humanId: task.humanId, tone: "red" });
      }
      if (owner.ownerType === "task" && state === "idle" && this.orchestratorObservations.length) {
        const orchestrator = this.ensureSession("orchestrator", "main");
        if (orchestrator.runState !== "running" && orchestrator.runState !== "waiting" && this.capacity().availableSlots > 0) {
          const observations = this.orchestratorObservations.splice(0).join("\n");
          void this.send(
            "orchestrator", "main",
            `Portfolio observation:\n${observations}\nDecide whether this is relevant enough to tell the user. If not, answer briefly that no intervention is needed. Do not start tasks from this observation.`,
            false, "system",
          ).catch((error) => this.addMessage("orchestrator", "main", "system", `Could not inspect the portfolio update: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (owner.ownerType === "orchestrator" && state === "idle" && this.pendingOrchestratorStarts.length) {
        const requested = this.pendingOrchestratorStarts;
        this.pendingOrchestratorStarts = [];
        for (const humanId of requested) {
          if (this.capacity().availableSlots <= 0) {
            this.addMessage("orchestrator", "main", "system", `${humanId} remains queued because the safe capacity limit was reached.`);
            continue;
          }
          void this.triggerTask(humanId, "orchestrator").catch((error) => {
            this.addMessage("orchestrator", "main", "system", `Could not start ${humanId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
      if (owner.ownerType === "orchestrator") this.orchestratorStartAuthorized = false;
      if (owner.ownerType === "orchestrator") this.orchestratorPriorityAuthorized = false;
    }
  }

  private finishAgentMessage(owner: Owner, itemId: string, raw: string): void {
    const parsed = parseAgentEnvelope(raw);
    const body = parsed.body || "Done.";
    this.addMessage(owner.ownerType, owner.ownerId, "assistant", body, null, itemId);
    if (owner.ownerType === "task") {
      if (parsed.surface) this.updateSession("task", owner.ownerId, { surface: parsed.surface });
      if (parsed.design) this.saveDesign(owner.ownerId, parsed.design);
      this.setPresence(owner.ownerId, parsed.message ?? "Ready", parsed.tone ?? "blue", "Updated by the task session");
      const completedTask = this.tasks.getTask(owner.ownerId);
      if (parsed.review && completedTask.status === "in_progress") {
        this.tasks.submitForReview(completedTask.id, {
          sessionId: this.ensureSession("task", owner.ownerId).threadId ?? undefined,
          summary: body.slice(0, 10_000),
        }, "codex");
      }
      if (parsed.tone && ["green", "orange", "red"].includes(parsed.tone)) {
        const task = this.tasks.getTask(owner.ownerId);
        this.orchestratorObservations.push(`${task.humanId} (${task.projectName}) changed to ${parsed.tone}: ${parsed.message ?? "Status changed"}.`);
      }
    }
    if (owner.ownerType === "orchestrator" && parsed.startTasks.length) {
      if (this.orchestratorStartAuthorized) this.pendingOrchestratorStarts = parsed.startTasks;
      else this.addMessage("orchestrator", "main", "system", "No tasks were started because this turn did not include user authorization to start work.");
    }
    if (owner.ownerType === "orchestrator" && parsed.priorityTasks.length) {
      if (this.orchestratorPriorityAuthorized) {
        this.tasks.prioritize(parsed.priorityTasks, "system");
        this.addMessage("orchestrator", "main", "system", `Priority updated: ${parsed.priorityTasks.join(" → ")}.`);
      } else this.addMessage("orchestrator", "main", "system", "Priority was not changed because the user did not authorize reordering in this turn.");
    }
  }

  private saveDesign(taskId: string, document: DesignDocument): void {
    const timestamp = isoNow();
    this.database.db.prepare(`
      INSERT INTO design_documents (task_id, document_json, revision, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(task_id) DO UPDATE SET document_json = excluded.document_json,
        revision = design_documents.revision + 1, updated_at = excluded.updated_at
    `).run(taskId, JSON.stringify(document), timestamp);
  }

  private storePending(owner: Owner, rpcId: string | number, method: string, params: JsonObject): void {
    const requestType: PendingRequest["requestType"] = method.includes("commandExecution") ? "command"
      : method.includes("fileChange") ? "file_change"
        : method.includes("userInput") ? "user_input"
          : method.toLowerCase().includes("permission") ? "permissions" : "other";
    this.database.db.prepare(`
      INSERT INTO pending_requests (id, owner_type, owner_id, rpc_request_id, request_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), owner.ownerType, owner.ownerId, JSON.stringify(rpcId), requestType, JSON.stringify({ method, ...params }), isoNow());
    this.updateSession(owner.ownerType, owner.ownerId, { runState: "waiting" });
    if (owner.ownerType === "task") this.setPresence(owner.ownerId, requestType === "user_input" ? "Needs clarification" : "Needs approval", "orange", method);
  }

  private ownerFromIds(threadId: string | null, turnId: string | null): Owner | null {
    const row = this.database.db.prepare(`
      SELECT owner_type, owner_id FROM agent_sessions WHERE (? IS NOT NULL AND thread_id = ?) OR (? IS NOT NULL AND active_turn_id = ?) LIMIT 1
    `).get(threadId, threadId, turnId, turnId) as { owner_type: SessionOwnerType; owner_id: string } | undefined;
    return row ? { ownerType: row.owner_type, ownerId: row.owner_id } : null;
  }

  private addMessage(
    ownerType: SessionOwnerType, ownerId: string, role: ChatMessage["role"], body: string,
    metadata: Record<string, unknown> | null = null, itemId: string | null = null,
  ): void {
    this.database.db.prepare(`
      INSERT OR IGNORE INTO chat_messages (id, owner_type, owner_id, codex_item_id, role, body, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), ownerType, ownerId, itemId, role, body, metadata ? JSON.stringify(metadata) : null, isoNow());
  }

  private setPresence(taskId: string, message: string, tone: TaskTone, reason: string): void {
    this.database.db.prepare(`
      INSERT INTO task_presence (task_id, message, tone, reason, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET message = excluded.message, tone = excluded.tone,
        reason = excluded.reason, updated_at = excluded.updated_at
    `).run(taskId, message.slice(0, 100), tone, reason.slice(0, 500), isoNow());
  }

  private updateSession(ownerType: SessionOwnerType, ownerId: string, values: {
    threadId?: string | null; activeTurnId?: string | null; surface?: SessionSurface;
    runState?: SessionRunState; lastError?: string | null;
  }): void {
    const current = this.ensureSession(ownerType, ownerId);
    this.database.db.prepare(`
      UPDATE agent_sessions SET thread_id = ?, active_turn_id = ?, surface = ?, run_state = ?, last_error = ?, updated_at = ?
      WHERE owner_type = ? AND owner_id = ?
    `).run(
      values.threadId === undefined ? current.threadId : values.threadId,
      values.activeTurnId === undefined ? current.activeTurnId : values.activeTurnId,
      values.surface ?? current.surface,
      values.runState ?? current.runState,
      values.lastError === undefined ? current.lastError : values.lastError,
      isoNow(), ownerType, ownerId,
    );
  }

  private recordEvent(owner: Owner, eventType: string, payload: JsonObject): void {
    this.database.db.prepare(`
      INSERT INTO session_events (owner_type, owner_id, thread_id, turn_id, item_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      owner.ownerType, owner.ownerId,
      typeof payload.threadId === "string" ? payload.threadId : null,
      typeof payload.turnId === "string" ? payload.turnId : null,
      typeof object(payload.payload).itemId === "string" ? object(payload.payload).itemId : null,
      eventType, JSON.stringify(payload), isoNow(),
    );
  }
}
