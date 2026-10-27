import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpus, freemem, loadavg, totalmem } from "node:os";
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
  type TaskIntakeState,
  type TaskWorkspace,
} from "../domain/types.js";
import type { AppDatabase } from "./database.js";
import type { TaskService } from "./task-service.js";

type JsonObject = Record<string, unknown>;
type Owner = { ownerType: SessionOwnerType; ownerId: string };
type RpcPending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type OrchestratorAction =
  | { type: "start"; taskId: string; authorization: string }
  | { type: "priority"; taskIds: string[]; authorization: string }
  | { type: "message"; taskId: string; message: string; authorization: string }
  | { type: "interrupt"; taskId: string; authorization: string };

interface SessionRow {
  id: string; owner_type: SessionOwnerType; owner_id: string; thread_id: string | null; active_turn_id: string | null;
  surface: SessionSurface; run_state: SessionRunState; generation: number; last_error: string | null;
  intake_state: TaskIntakeState;
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
  loadAverage1m: number;
  loadRatio: number;
  memoryPressure: boolean;
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
  const ids = [...document.html.matchAll(/data-qahwa-id\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  return document.artboard.width > 0 && document.artboard.width <= 10_000 && document.artboard.height > 0 && document.artboard.height <= 30_000
    && document.html.length <= 500_000 && document.css.length <= 500_000
    && (!document.html.trim() || (ids.length > 0 && new Set(ids).size === ids.length))
    && !/<\s*\/?\s*(script|iframe|object|embed|form|input|textarea|select|link|meta|style)\b/i.test(document.html)
    && !/\son[a-z]+\s*=/i.test(document.html)
    && !/(?:javascript|data\s*:\s*text\/html)\s*:/i.test(source)
    && !/@import\b/i.test(document.css);
}

function sessionFromRow(row: SessionRow): AgentSession {
  return {
    id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, threadId: row.thread_id,
    activeTurnId: row.active_turn_id, surface: row.surface, runState: row.run_state,
    generation: row.generation, intakeState: row.intake_state, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
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

export function recommendedParallelism(logicalCpus = cpus().length, freeBytes = freemem(), totalBytes = totalmem(), oneMinuteLoad = 0): number {
  const memoryGiB = freeBytes / 1024 ** 3;
  const memoryPressure = totalBytes > 0 && freeBytes / totalBytes < 0.18;
  if (logicalCpus <= 2 || memoryGiB < 1.5 || memoryPressure) return 1;
  const baseline = logicalCpus <= 6 || memoryGiB < 6 ? 2 : Math.min(4, Math.max(2, Math.floor(logicalCpus / 3)));
  const loadRatio = logicalCpus ? oneMinuteLoad / logicalCpus : 1;
  return loadRatio >= .85 ? 1 : loadRatio >= .6 ? Math.max(1, baseline - 1) : baseline;
}

export function hasCurrentUserAuthorization(userMessage: string | undefined, exactQuote: string): boolean {
  return Boolean(userMessage && exactQuote && userMessage.includes(exactQuote));
}

export function parseAgentEnvelope(text: string): {
  body: string; message?: string; tone?: TaskTone; surface?: SessionSurface; design?: DesignDocument; review: boolean;
  startTasks: string[]; priorityTasks: string[]; intakeReady?: boolean; silent: boolean; actions: OrchestratorAction[];
} {
  let body = text.trim();
  let message: string | undefined;
  let tone: TaskTone | undefined;
  let surface: SessionSurface | undefined;
  let design: DesignDocument | undefined;
  let review = false;
  const startTasks: string[] = [];
  const priorityTasks: string[] = [];
  const actions: OrchestratorAction[] = [];
  let intakeReady: boolean | undefined;
  let silent = false;
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
  body = body.replace(/<!--\s*qahwa-intake:(\{[\s\S]*?\})\s*-->/i, (_match, value: string) => {
    try { intakeReady = object(JSON.parse(value)).ready === true; } catch { intakeReady = false; }
    return "";
  }).trim();
  body = body.replace(/<!--\s*qahwa-silent\s*-->/gi, () => { silent = true; return ""; }).trim();
  body = body.replace(/<!--\s*qahwa-actions:(\[[\s\S]*?\])\s*-->/i, (_match, value: string) => {
    try {
      for (const candidate of JSON.parse(value) as Array<Record<string, unknown>>) {
        const type = String(candidate.type ?? "");
        const taskId = String(candidate.taskId ?? "").toUpperCase();
        const authorization = typeof candidate.authorization === "string" ? candidate.authorization.trim().slice(0, 2_000) : "";
        if (type === "start" && taskId) actions.push({ type, taskId, authorization });
        else if (type === "interrupt" && taskId) actions.push({ type, taskId, authorization });
        else if (type === "message" && taskId && typeof candidate.message === "string" && candidate.message.trim()) actions.push({ type, taskId, message: candidate.message.trim().slice(0, 30_000), authorization });
        else if (type === "priority" && Array.isArray(candidate.taskIds)) actions.push({ type, taskIds: candidate.taskIds.map(String).map((id) => id.toUpperCase()).filter(Boolean), authorization });
      }
    } catch { /* malformed actions remain inert */ }
    return "";
  }).trim();
  for (const taskId of startTasks) actions.push({ type: "start", taskId, authorization: "" });
  if (priorityTasks.length) actions.push({ type: "priority", taskIds: priorityTasks, authorization: "" });
  return { body, message, tone, surface, design, review, startTasks, priorityTasks, intakeReady, silent, actions };
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
  private readonly orchestratorUserTurns = new Map<string, string>();
  private readonly orchestratorObservations: string[] = [];
  private observationTimer: NodeJS.Timeout | null = null;
  private readonly monitorTimer: NodeJS.Timeout;
  private readonly monitorNotices = new Set<string>();

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
    this.monitorTimer = setInterval(() => void this.monitorPortfolio(), 60_000);
    this.monitorTimer.unref();
    void this.drainSchedulerQueue();
  }

  capacity(): CapacitySnapshot {
    const logicalCpus = cpus().length;
    const freeMemoryBytes = freemem();
    const totalMemoryBytes = totalmem();
    const loadAverage1m = loadavg()[0] ?? 0;
    const activeTurns = Number((this.database.db.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE run_state = 'running'").get() as { count: number }).count);
    const parallelism = recommendedParallelism(logicalCpus, freeMemoryBytes, totalMemoryBytes, loadAverage1m);
    return { logicalCpus, freeMemoryBytes, totalMemoryBytes, activeTurns, recommendedParallelism: parallelism, availableSlots: Math.max(0, parallelism - activeTurns), loadAverage1m, loadRatio: logicalCpus ? loadAverage1m / logicalCpus : 1, memoryPressure: totalMemoryBytes > 0 && freeMemoryBytes / totalMemoryBytes < .18 };
  }

  workspace(ownerType: SessionOwnerType, ownerId: string): TaskWorkspace {
    ownerId = this.canonicalOwnerId(ownerType, ownerId);
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
    const recentEvents = (this.database.db.prepare(`SELECT event_type AS type, created_at AS createdAt FROM session_events
      WHERE owner_type = ? AND owner_id = ? ORDER BY id DESC LIMIT 30`).all(ownerType, ownerId) as Array<{ type: string; createdAt: string }>).reverse();
    return {
      session, messages, pendingRequests,
      design: designRow ? { document: JSON.parse(designRow.document_json) as DesignDocument, revision: designRow.revision, updatedAt: designRow.updated_at } : null,
      designVersions,
      recentEvents,
    };
  }

  async triggerTask(taskId: string, actor: "user" | "orchestrator" = "user"): Promise<TaskWorkspace> {
    const task = this.tasks.getTask(taskId);
    const session = this.ensureSession("task", task.id);
    assertDomain(session.runState !== "running", "This task is already running", "task_running", 409);
    const capacity = this.capacity();
    assertDomain(capacity.availableSlots > 0, "The computer is at its safe parallel-work limit", "capacity_full", 409);
    assertDomain(!this.projectHasRunningTask(task.projectId, task.id), `Another ${task.projectName} task is already running in the same worktree`, "project_conflict", 409);
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
    this.database.db.prepare("DELETE FROM scheduler_queue WHERE task_id = ?").run(task.id);
    return this.workspace("task", task.id);
  }

  private projectHasRunningTask(projectId: string, exceptTaskId?: string): boolean {
    return Boolean(this.database.db.prepare(`
      SELECT 1 FROM agent_sessions s JOIN tasks t ON t.id = s.owner_id
      WHERE s.owner_type = 'task' AND s.run_state IN ('running','waiting') AND t.project_id = ? AND t.id != ? LIMIT 1
    `).get(projectId, exceptTaskId ?? ""));
  }

  async send(ownerType: SessionOwnerType, ownerId: string, body: string, initial = false, messageRole: ChatMessage["role"] = "user"): Promise<TaskWorkspace> {
    ownerId = this.canonicalOwnerId(ownerType, ownerId);
    const text = body.trim();
    assertDomain(text.length > 0 && text.length <= 30_000, "Message must be 1–30,000 characters", "invalid_message");
    const session = this.ensureSession(ownerType, ownerId);
    assertDomain(session.runState !== "running", "This session is already working", "session_running", 409);
    assertDomain(this.capacity().availableSlots > 0, "The computer is at its safe parallel-work limit", "capacity_full", 409);
    if (ownerType === "task") {
      const task = this.tasks.getTask(ownerId);
      assertDomain(task.status !== "closed", "Closed tasks cannot receive new work", "task_closed", 409);
      if (task.status === "in_review") this.tasks.transition(task.id, { to: "in_progress" }, "codex");
    }
    this.addMessage(ownerType, ownerId, messageRole, text);
    this.updateSession(ownerType, ownerId, { runState: "running", lastError: null });
    if (ownerType === "task") this.setPresence(ownerId, "Working", "blue", "A Codex turn is active");
    try {
      await this.codex.initialize();
      const cwd = ownerType === "task" ? this.tasks.getTask(ownerId).rootDirectory : process.cwd();
      const developerInstructions = this.developerInstructions(ownerType, ownerId, session.intakeState);
      let threadId = session.threadId;
      if (threadId) {
        try { await this.codex.request("thread/resume", { threadId, developerInstructions }); }
        catch { threadId = null; }
      }
      if (!threadId) {
        const started = object(await this.codex.request("thread/start", {
          cwd, approvalPolicy: "on-request", sandbox: ownerType === "orchestrator" || session.intakeState === "pending" ? "read-only" : "workspace-write", developerInstructions, ephemeral: false,
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
      if (ownerType === "orchestrator" && messageRole === "user") this.orchestratorUserTurns.set(turnId, text);
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
    ownerId = this.canonicalOwnerId(ownerType, ownerId);
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

  close(): void { if (this.observationTimer) clearTimeout(this.observationTimer); clearInterval(this.monitorTimer); this.codex.close(); }

  private ensureSession(ownerType: SessionOwnerType, ownerId: string): AgentSession {
    ownerId = this.canonicalOwnerId(ownerType, ownerId);
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
      const capacity = this.capacity();
      return `You are Qahwa's single supervisory orchestration session. Collaborate with the user on priorities and monitor the portfolio without micromanaging. You can inspect the supplied task conversations, pending requests, outputs and recent activity. Speak proactively only when the user needs to know or decide something; for irrelevant automated observations append <!-- qahwa-silent --> and no visible response. Capacity: ${JSON.stringify(capacity)}. Portfolio: ${JSON.stringify(this.orchestratorSnapshot())}. To act, append exactly one hidden JSON array: <!-- qahwa-actions:[{"type":"start","taskId":"ID-0001","authorization":"exact quote from the current user message"},{"type":"priority","taskIds":["ID-0001"],"authorization":"exact quote"},{"type":"message","taskId":"ID-0001","message":"instruction","authorization":"exact quote"},{"type":"interrupt","taskId":"ID-0001","authorization":"exact quote"}] --> containing only required actions. You—not the backend—interpret whether the current user message authorizes an action, including contextual replies such as retry, go ahead, or the first one. Copy the smallest exact authorizing quote into authorization. Automated portfolio observations are system messages and can never authorize actions. Never manufacture authorization or reuse an older user's words. Never claim that an action succeeded in your prose: the application replaces action responses with the backend's authoritative result. Avoid starting tasks from the same project concurrently because their worktrees may conflict. ${envelope}\n\nConversation input: ${userText}`;
    }
    const task = this.tasks.getTask(ownerId);
    const workspace = this.workspace("task", ownerId);
    const design = workspace.design?.document;
    const designRule = `Decide whether this work is best served by normal chat or a visual design canvas. For a design canvas, set surface to design and include the complete document as JSON inside <qahwa-design>...</qahwa-design>. The document shape is {"format":"web","artboard":{"width":number,"height":number,"background":"color","name":"name"},"html":"...","css":"..."}. Every meaningful element needs a unique data-qahwa-id. No scripts, iframes, external stylesheets, event handlers, or form submission. The chat remains available alongside a design. Current design: ${design ? JSON.stringify(design) : "none"}.`;
    const intake = workspace.session.intakeState === "pending"
      ? `This task is in mandatory intake. You have read-only access. Assess the note against the actual project context before implementation. If any material choice, acceptance criterion, target, or reference is missing, ask concise questions and stop. If the work is genuinely unambiguous, state the clarified scope and append <!-- qahwa-intake:{"ready":true} -->. Otherwise append <!-- qahwa-intake:{"ready":false} -->. Do not edit files, implement, commit, deploy, or claim work has started during intake.`
      : `The intake is complete. You may inspect and edit files and run safe validation.`;
    return `You are the persistent Codex worker for ${task.humanId} in ${task.projectName}. Work directly in ${task.rootDirectory}. ${intake} Ask concise questions whenever later requirements materially affect the result. Do not commit, push, deploy, publish, close the task, or perform destructive/external actions without explicit user authorization in this task chat. ${designRule} ${envelope}\n\n${initial ? "Initial task note" : "Conversation input"}: ${userText}`;
  }

  private developerInstructions(ownerType: SessionOwnerType, ownerId: string, intakeState: TaskIntakeState): string {
    if (ownerType === "orchestrator") return "You are Qahwa's single supervisory orchestrator. Monitor task progress, help the user prioritize, and coordinate authorized work without micromanaging. Never invent authorization. Communicate proactively only when information is materially relevant; otherwise remain silent using the application's silent marker. Treat application-supplied portfolio data as authoritative and use only the documented hidden action envelope.";
    const task = this.tasks.getTask(ownerId);
    return intakeState === "pending"
      ? `You are the persistent Codex session for ${task.humanId}. You are in mandatory read-only intake: inspect context, clarify material ambiguity, and do not implement or edit until the application starts a new implementation thread.`
      : `You are the persistent Codex worker for ${task.humanId} in ${task.projectName}. Work in ${task.rootDirectory}, follow the clarified scope, validate proportionately, and respect explicit authorization gates for commit, push, deploy, publishing, closure, destructive actions, and external side effects.`;
  }

  private orchestratorSnapshot(): unknown[] {
    return this.tasks.listTasks({ tab: "active" }).map((summary) => {
      const task = this.tasks.getTask(summary.id);
      const messages = this.database.db.prepare(`
        SELECT role, body, created_at AS createdAt FROM chat_messages
        WHERE owner_type = 'task' AND owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 8
      `).all(task.id) as Array<{ role: string; body: string; createdAt: string }>;
      const pending = this.database.db.prepare(`
        SELECT request_type AS type, payload_json AS payload, created_at AS createdAt FROM pending_requests
        WHERE owner_type = 'task' AND owner_id = ? AND status = 'pending' ORDER BY created_at
      `).all(task.id) as Array<{ type: string; payload: string; createdAt: string }>;
      const sessionEvents = this.database.db.prepare(`
        SELECT event_type AS type, created_at AS createdAt FROM session_events
        WHERE owner_type = 'task' AND owner_id = ? ORDER BY id DESC LIMIT 12
      `).all(task.id) as Array<{ type: string; createdAt: string }>;
      return {
        id: task.humanId, project: task.projectName, rootDirectory: task.rootDirectory, title: task.title,
        description: plainTextFromDocument(task.description).slice(0, 2_000), status: task.status, session: task.sessionState,
        intake: this.ensureSession("task", task.id).intakeState, smartMessage: task.smartMessage, tone: task.tone,
        lastActivityAt: task.lastActivityAt, unresolvedComments: task.unresolvedCommentCount,
        pending: pending.map((item) => ({ ...item, payload: object(JSON.parse(item.payload)) })),
        recentConversation: messages.reverse().map((item) => ({ ...item, body: item.body.slice(0, 2_000) })),
        latestOutput: task.outputs.at(-1) ? { summary: task.outputs.at(-1)!.summary, validation: task.outputs.at(-1)!.validation, limitations: task.outputs.at(-1)!.limitations } : null,
        recentActivity: this.tasks.activityForTask(task.id, 8),
        recentSessionEvents: sessionEvents.reverse(),
      };
    });
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
        this.finishAgentMessage(owner, String(item.id ?? randomUUID()), item.text, turnId);
      }
    }
    if (method === "turn/completed") {
      const turn = object(params.turn);
      const status = String(turn.status ?? "completed");
      const state: SessionRunState = status === "completed" ? "idle" : status === "interrupted" ? "interrupted" : "failed";
      this.updateSession(owner.ownerType, owner.ownerId, { runState: state, activeTurnId: null, lastError: state === "failed" ? status : null });
      if (turnId) this.turnOwners.delete(turnId);
      if (turnId) this.orchestratorUserTurns.delete(turnId);
      if (owner.ownerType === "task" && state === "failed") {
        this.setPresence(owner.ownerId, "Run failed", "red", status);
        const task = this.tasks.getTask(owner.ownerId);
        this.addMessage("orchestrator", "main", "system", `${task.humanId} · run failed`, { taskId: task.id, humanId: task.humanId, tone: "red" });
      }
      if (owner.ownerType === "task" && this.orchestratorObservations.length) this.scheduleOrchestratorObservation();
      if (this.orchestratorObservations.length) this.scheduleOrchestratorObservation();
      void this.drainSchedulerQueue();
    }
  }

  private finishAgentMessage(owner: Owner, itemId: string, raw: string, turnId: string | null): void {
    const parsed = parseAgentEnvelope(raw);
    const body = parsed.body || "Done.";
    if (!parsed.silent && !(owner.ownerType === "orchestrator" && parsed.actions.length)) this.addMessage(owner.ownerType, owner.ownerId, "assistant", body, null, itemId);
    if (owner.ownerType === "task") {
      const session = this.ensureSession("task", owner.ownerId);
      if (session.intakeState === "pending") {
        if (parsed.intakeReady) {
          this.updateSession("task", owner.ownerId, { intakeState: "ready" });
          this.database.db.prepare(`INSERT INTO scheduler_queue(task_id, requested_by, reason, created_at) VALUES (?, 'intake', ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET requested_by=excluded.requested_by, reason=excluded.reason, created_at=excluded.created_at`)
            .run(owner.ownerId, "Mandatory intake completed", isoNow());
          this.setPresence(owner.ownerId, "Scope clarified", "blue", "Mandatory intake completed");
        } else this.setPresence(owner.ownerId, "Needs clarification", "orange", "Mandatory intake is not complete");
      } else {
        if (parsed.surface) this.updateSession("task", owner.ownerId, { surface: parsed.surface });
        if (parsed.design) this.saveDesign(owner.ownerId, parsed.design);
        this.setPresence(owner.ownerId, parsed.message ?? "Ready", parsed.tone ?? "blue", "Updated by the task session");
      }
      const completedTask = this.tasks.getTask(owner.ownerId);
      if (session.intakeState === "ready" && parsed.review && completedTask.status === "in_progress") {
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
    if (owner.ownerType === "orchestrator" && parsed.actions.length) {
      const authorizingUserMessage = turnId ? this.orchestratorUserTurns.get(turnId) : undefined;
      void this.applyOrchestratorActions(parsed.actions, authorizingUserMessage).then((outcomes) => {
        if (!parsed.silent) this.addMessage("orchestrator", "main", "assistant", outcomes.join("\n"), null, itemId);
      });
    }
  }

  private async applyOrchestratorActions(actions: OrchestratorAction[], authorizingUserMessage?: string): Promise<string[]> {
    const outcomes: string[] = [];
    const requestedStarts: string[] = [];
    for (const action of actions) {
      try {
        if (!hasCurrentUserAuthorization(authorizingUserMessage, action.authorization)) {
          throw new Error("The action was not authorized by the current user message");
        }
        if (action.type === "start") {
          const task = this.tasks.getTask(action.taskId);
          this.database.db.prepare(`INSERT INTO scheduler_queue(task_id, requested_by, reason, created_at) VALUES (?, 'orchestrator', ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET reason=excluded.reason, created_at=excluded.created_at`).run(task.id, "Authorized by the user through the orchestrator", isoNow());
          requestedStarts.push(task.humanId);
        } else if (action.type === "priority") {
          this.tasks.prioritize(action.taskIds, "system");
          outcomes.push(`Priority updated: ${action.taskIds.join(" → ")}.`);
        } else if (action.type === "message") {
          await this.messageTask(action.taskId, action.message);
          outcomes.push(`Guidance sent to ${action.taskId}.`);
        } else if (action.type === "interrupt") {
          await this.interrupt("task", this.tasks.getTask(action.taskId).id);
          outcomes.push(`${action.taskId} was interrupted.`);
        }
      } catch (error) {
        outcomes.push(`${action.type} ${"taskId" in action ? action.taskId : "tasks"} was not applied: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.drainSchedulerQueue(false);
    for (const humanId of requestedStarts) {
      const task = this.tasks.getTask(humanId);
      const queued = this.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(task.id);
      outcomes.push(queued ? `${humanId} is queued and will start when capacity and its worktree are available.` : `${humanId} started.`);
    }
    return outcomes.length ? outcomes : ["No action was applied."];
  }

  private async messageTask(taskId: string, message: string): Promise<void> {
    const task = this.tasks.getTask(taskId);
    const session = this.ensureSession("task", task.id);
    this.addMessage("task", task.id, "system", `Orchestrator guidance: ${message}`);
    if (session.runState === "running" && session.threadId && session.activeTurnId) {
      await this.codex.request("turn/steer", { threadId: session.threadId, input: [{ type: "text", text: `Orchestrator guidance authorized by the user: ${message}` }] });
      return;
    }
    if (session.runState === "waiting") throw new Error("The task is waiting for user input and cannot be redirected yet");
    await this.send("task", task.id, `Orchestrator guidance authorized by the user: ${message}`, false, "system");
  }

  private async drainSchedulerQueue(announce = true): Promise<void> {
    const queued = this.database.db.prepare(`SELECT q.task_id, q.requested_by FROM scheduler_queue q JOIN tasks t ON t.id=q.task_id ORDER BY t.rank, q.created_at`).all() as Array<{ task_id: string; requested_by: string }>;
    for (const row of queued) {
      if (this.capacity().availableSlots <= 0) return;
      const task = this.tasks.getTask(row.task_id);
      if (this.projectHasRunningTask(task.projectId, task.id)) continue;
      try {
        if (row.requested_by === "intake") await this.beginImplementation(task.id);
        else await this.triggerTask(task.id, "orchestrator");
        if (announce) this.addMessage("orchestrator", "main", "system", `${task.humanId} ${row.requested_by === "intake" ? "finished intake and began implementation" : "started"}.`);
      } catch (error) {
        if (announce) this.addMessage("orchestrator", "main", "system", `${task.humanId} remains queued: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async beginImplementation(taskId: string): Promise<void> {
    const task = this.tasks.getTask(taskId);
    const session = this.ensureSession("task", task.id);
    assertDomain(session.intakeState === "ready", "Task intake is not complete", "intake_incomplete", 409);
    assertDomain(!["running", "waiting"].includes(session.runState), "The intake turn has not finished", "intake_running", 409);
    assertDomain(this.capacity().availableSlots > 0, "The computer is at its safe parallel-work limit", "capacity_full", 409);
    assertDomain(!this.projectHasRunningTask(task.projectId, task.id), `Another ${task.projectName} task is already running in the same worktree`, "project_conflict", 409);
    if (session.threadId) {
      await this.codex.initialize();
      await this.codex.request("thread/archive", { threadId: session.threadId }).catch(() => undefined);
      this.threadOwners.delete(session.threadId);
    }
    this.updateSession("task", task.id, { threadId: null, activeTurnId: null, runState: "idle" });
    await this.send("task", task.id, "The mandatory intake is complete. Proceed with the clarified task now, using the agreed scope and proportionate validation.", false, "system");
    this.database.db.prepare("DELETE FROM scheduler_queue WHERE task_id = ?").run(task.id);
  }

  private saveDesign(taskId: string, document: DesignDocument): void {
    assertDomain(safeDesign(document), "The design document is unsafe or invalid", "invalid_design");
    const timestamp = isoNow();
    const current = this.database.db.prepare("SELECT document_json, revision FROM design_documents WHERE task_id = ?").get(taskId) as { document_json: string; revision: number } | undefined;
    if (current) this.database.db.prepare(`
      INSERT INTO design_versions (id, task_id, name, document_json, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), taskId, `Revision ${current.revision}`, current.document_json, current.revision, timestamp);
    this.database.db.prepare(`
      INSERT INTO design_documents (task_id, document_json, revision, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(task_id) DO UPDATE SET document_json = excluded.document_json,
        revision = design_documents.revision + 1, updated_at = excluded.updated_at
    `).run(taskId, JSON.stringify(document), timestamp);
  }

  createDesignVersion(taskId: string, name: string): TaskWorkspace {
    const task = this.tasks.getTask(taskId);
    const current = this.database.db.prepare("SELECT document_json, revision FROM design_documents WHERE task_id = ?").get(task.id) as { document_json: string; revision: number } | undefined;
    assertDomain(current, "This task has no design canvas", "design_not_found", 404);
    this.database.db.prepare("INSERT INTO design_versions (id, task_id, name, document_json, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), task.id, name.trim().slice(0, 80) || `Version ${current.revision}`, current.document_json, current.revision, isoNow());
    return this.workspace("task", task.id);
  }

  restoreDesignVersion(taskId: string, versionId: string): TaskWorkspace {
    const task = this.tasks.getTask(taskId);
    const version = this.database.db.prepare("SELECT document_json FROM design_versions WHERE id = ? AND task_id = ?").get(versionId, task.id) as { document_json: string } | undefined;
    assertDomain(version, "Design version not found", "design_version_not_found", 404);
    this.saveDesign(task.id, JSON.parse(version.document_json) as DesignDocument);
    return this.workspace("task", task.id);
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
    if (owner.ownerType === "task") {
      const task = this.tasks.getTask(owner.ownerId);
      this.orchestratorObservations.push(`${task.humanId} (${task.projectName}) is waiting for ${requestType === "user_input" ? "clarification" : "approval"}.`);
      this.scheduleOrchestratorObservation();
    }
  }

  private scheduleOrchestratorObservation(): void {
    if (this.observationTimer) return;
    this.observationTimer = setTimeout(() => {
      this.observationTimer = null;
      if (!this.orchestratorObservations.length) return;
      const orchestrator = this.ensureSession("orchestrator", "main");
      if (orchestrator.runState === "running" || orchestrator.runState === "waiting" || this.capacity().availableSlots <= 0) return;
      const observations = this.orchestratorObservations.splice(0).join("\n");
      void this.send("orchestrator", "main", `Automated portfolio observation:\n${observations}\nTell the user only if this materially needs attention. Otherwise return <!-- qahwa-silent -->. Never take an action from an automated observation.`, false, "system")
        .catch((error) => this.addMessage("orchestrator", "main", "system", `Could not inspect the portfolio update: ${error instanceof Error ? error.message : String(error)}`));
    }, 250);
  }

  private async monitorPortfolio(): Promise<void> {
    await this.drainSchedulerQueue();
    const rows = this.database.db.prepare(`
      SELECT s.owner_id AS taskId, s.run_state AS runState, s.updated_at AS updatedAt, t.human_id AS humanId, p.name AS projectName
      FROM agent_sessions s JOIN tasks t ON t.id=s.owner_id JOIN projects p ON p.id=t.project_id
      WHERE s.owner_type='task' AND s.run_state IN ('running','waiting')
    `).all() as Array<{ taskId: string; runState: string; updatedAt: string; humanId: string; projectName: string }>;
    const now = Date.now();
    for (const row of rows) {
      if (row.runState !== "running" || now - new Date(row.updatedAt).getTime() < 20 * 60_000) continue;
      const key = `${row.taskId}:${row.updatedAt}`;
      if (this.monitorNotices.has(key)) continue;
      this.monitorNotices.add(key);
      this.orchestratorObservations.push(`${row.humanId} (${row.projectName}) has had an active turn for more than 20 minutes; inspect its recent session events and decide whether the user should know.`);
    }
    if (this.orchestratorObservations.length) this.scheduleOrchestratorObservation();
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
    ownerId = this.canonicalOwnerId(ownerType, ownerId);
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
    runState?: SessionRunState; lastError?: string | null; intakeState?: TaskIntakeState;
  }): void {
    ownerId = this.canonicalOwnerId(ownerType, ownerId);
    const current = this.ensureSession(ownerType, ownerId);
    this.database.db.prepare(`
      UPDATE agent_sessions SET thread_id = ?, active_turn_id = ?, surface = ?, run_state = ?, intake_state = ?, last_error = ?, updated_at = ?
      WHERE owner_type = ? AND owner_id = ?
    `).run(
      values.threadId === undefined ? current.threadId : values.threadId,
      values.activeTurnId === undefined ? current.activeTurnId : values.activeTurnId,
      values.surface ?? current.surface,
      values.runState ?? current.runState,
      values.intakeState ?? current.intakeState,
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

  private canonicalOwnerId(ownerType: SessionOwnerType, ownerId: string): string {
    return ownerType === "task" ? this.tasks.getTask(ownerId).id : ownerId;
  }
}
