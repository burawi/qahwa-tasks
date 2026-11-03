import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import * as pty from "node-pty";
import { assertDomain } from "../domain/errors.js";
import type { ChatMessage, TerminalView } from "../domain/types.js";
import type { AppDatabase } from "./database.js";
import type { TaskService } from "./task-service.js";
import { stopTerminalProcesses, terminalProcessOwner, type TerminalProcessOwner } from "./terminal-processes.js";
import { editingBlocker } from "./task-access.js";

const { Terminal } = headless;
const { SerializeAddon } = serialize;
const SCROLLBACK = 5000;
const MAX_DELTA = 256 * 1024;
const timestamp = () => new Date().toISOString();
interface TerminalRow {
  task_id: string; generation: string; root_directory: string; state: TerminalView["state"];
  cols: number; rows: number; snapshot: string; cursor: number; exit_code: number | null; error: string | null;
}
interface LiveTerminal {
  row: TerminalRow;
  process: pty.IPty;
  screen: InstanceType<typeof Terminal>;
  serializer: InstanceType<typeof SerializeAddon>;
  events: Array<{ cursor: number; data: string }>;
  bytes: number;
  queuedBytes: number;
  parsed: Promise<void>;
  waiters: Set<() => void>;
  flushTimer?: NodeJS.Timeout;
  outputScreen: InstanceType<typeof Terminal>;
  outputMessageId: string | null;
  expectedEcho: string;
  atPrompt: boolean;
  stopRequested?: boolean;
  exited: Promise<void>;
  owner: TerminalProcessOwner | undefined;
}

/** Shell ownership is independent of browser connections and Codex workers. */
export class TerminalService {
  private readonly live = new Map<string, LiveTerminal>();
  private readonly operations = new Map<string, Promise<void>>();
  private closed = false;
  private readonly legacyReceiptColumn: boolean;

  constructor(private readonly database: AppDatabase, private readonly tasks: TaskService) {
    // Early builds were loaded by long-lived MCP processes before deployment.
    // Preserve their receipts without retaining new keystroke hashes.
    this.legacyReceiptColumn = (database.db.prepare("PRAGMA table_info(terminal_input_receipts)").all() as Array<{ name: string }>).some(column => column.name === "data_hash");
    database.db.prepare(`UPDATE terminal_sessions SET state = 'interrupted', error = 'Server restarted. Start a new shell to continue.'
      WHERE state = 'running'`).run();
    database.db.prepare(`UPDATE task_presence SET message = 'Shell interrupted', tone = 'orange'
      WHERE task_id IN (SELECT task_id FROM terminal_sessions WHERE state = 'interrupted')`).run();
  }

  async create(projectId: unknown, creationKey: unknown, deviceId: string) {
    this.key(creationKey);
    assertDomain(typeof projectId === "string", "Select a project", "invalid_project");
    const existing = this.database.db.prepare("SELECT task_id FROM terminal_sessions WHERE device_id = ? AND creation_key = ?")
      .get(deviceId, creationKey) as { task_id: string } | undefined;
    if (existing) {
      const task = this.tasks.getTask(existing.task_id);
      assertDomain(task.projectId === projectId, "Terminal request used for another project", "terminal_conflict", 409);
      return { task, terminal: await this.read(task.id) };
    }
    const project = this.tasks.listProjects(true).find(project => project.id === projectId);
    assertDomain(project, "Project not found", "project_not_found", 404);
    assertDomain(!project.archivedAt, "Select an active project", "project_archived", 409);
    let directoryExists = false;
    try { directoryExists = statSync(project.rootDirectory).isDirectory(); } catch { /* useful error below */ }
    assertDomain(directoryExists, "Project directory is unavailable on the server", "terminal_directory", 409);
    const task = this.database.db.transaction(() => {
      const task = this.tasks.createTask({ projectId, title: `Terminal · ${project.name}`.slice(0, 200) }, "user");
      this.database.db.prepare("UPDATE tasks SET session_kind = 'terminal' WHERE id = ?").run(task.id);
      this.database.db.prepare(`INSERT INTO terminal_sessions
        (task_id, generation, device_id, creation_key, root_directory, state, updated_at)
        VALUES (?, ?, ?, ?, ?, 'interrupted', ?)`).run(task.id, randomUUID(), deviceId, creationKey, project.rootDirectory, timestamp());
      return task;
    })();
    await this.start(task.id);
    return { task: this.tasks.getTask(task.id), terminal: await this.read(task.id) };
  }

  async start(taskId: string, expectedGeneration?: unknown): Promise<void> {
    assertDomain(!this.closed, "Terminal service is stopping", "terminal_stopping", 503);
    const row = this.row(taskId);
    if (expectedGeneration !== undefined) this.checkGeneration(row, expectedGeneration);
    assertDomain(!this.operations.has(row.task_id), "Terminal is stopping. Try again shortly.", "terminal_busy", 409);
    assertDomain(this.tasks.getTask(row.task_id).status !== "closed", "Closed terminals cannot be started", "task_closed", 409);
    assertDomain(!this.live.has(row.task_id) || row.state !== "running", "Shell is already running", "terminal_running", 409);
    const operation = Promise.resolve().then(async () => {
      // Natural shell exit can leave detached jobs alive. Finish the previous
      // generation before replacing its ownership record with a fresh shell.
      await this.stopLive(row.task_id);
      await this.startShell(row.task_id);
    });
    this.operations.set(row.task_id, operation);
    try { await operation; }
    finally { if (this.operations.get(row.task_id) === operation) this.operations.delete(row.task_id); }
  }

  private async startShell(taskId: string): Promise<void> {
    assertDomain(!this.closed, "Terminal service is stopping", "terminal_stopping", 503);
    const row = { ...this.row(taskId) };
    assertDomain(this.tasks.getTask(row.task_id).status !== "closed", "Closed terminals cannot be started", "task_closed", 409);
    const previous = this.live.get(row.task_id);
    if (previous) {
      if (previous.flushTimer) clearTimeout(previous.flushTimer);
      this.wake(previous);
      previous.screen.dispose();
      previous.outputScreen.dispose();
      this.live.delete(row.task_id);
    }
    row.generation = randomUUID();
    row.error = null;
    row.exit_code = null;
    this.database.db.transaction(() => {
      const blocker = editingBlocker(this.database, row.task_id, row.root_directory);
      assertDomain(!blocker, `Waiting for exclusive editing access: ${blocker} is active in the same worktree`, "project_conflict", 409);
      row.state = "running";
      this.saveRow(row);
    }).immediate();
    const screen = new Terminal({ cols: row.cols, rows: row.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    // Reserve ownership before awaiting parsing, including simultaneous start requests.
    let process: pty.IPty;
    try {
      const shell = processShell();
      process = pty.spawn(shell, /(?:^|\/)bash$/.test(shell) ? ["--noprofile", "--norc", "-i"] : ["-i"], {
        name: "xterm-256color", cwd: row.root_directory, cols: row.cols, rows: row.rows,
        env: { ...shellEnvironment(), QAHWA_TERMINAL_GENERATION: row.generation },
      });
    } catch (error) {
      row.state = "failed";
      row.error = `Could not start shell: ${error instanceof Error ? error.message : String(error)}`;
      this.saveRow(row);
      screen.dispose();
      this.presence(row);
      return;
    }
    row.state = "running";
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    const live: LiveTerminal = { row, process, screen, serializer, events: [], bytes: 0, queuedBytes: 0, exited: exit, owner: terminalProcessOwner(process.pid),
      parsed: Promise.resolve(), waiters: new Set(), outputScreen: new Terminal({ cols: row.cols, rows: row.rows, scrollback: SCROLLBACK, allowProposedApi: true }),
      outputMessageId: null, expectedEcho: "", atPrompt: false };
    let ready!: () => void;
    let readyTimer: NodeJS.Timeout;
    const shellReady = new Promise<void>(resolve => {
      ready = () => { clearTimeout(readyTimer); resolve(); };
      readyTimer = setTimeout(ready, 1000);
    });
    screen.parser.registerOscHandler(133, data => { if (data === "A") { live.atPrompt = true; ready(); } return true; });
    this.live.set(row.task_id, live);
    this.saveRow(row);
    if (row.snapshot) this.append(live, `${row.snapshot}\r\n\x1b[0m[New shell]\r\n`);
    process.onData(data => { if (!this.closed) this.append(live, data); });
    process.onExit(({ exitCode }) => {
      ready();
      exited();
      if (this.closed) return;
      live.parsed = live.parsed.then(() => {
        if (this.live.get(row.task_id) !== live || live.stopRequested) return;
        row.state = "exited";
        row.exit_code = exitCode;
        this.persist(live);
        this.presence(row);
        this.wake(live);
      });
    });
    this.presence(row);
    await shellReady;
  }

  private checkGeneration(row: TerminalRow, generation: unknown): void {
    this.key(generation);
    assertDomain(row.generation === generation, "Shell changed. Refresh before trying again.", "terminal_generation", 409);
  }

  /** Serialize lifecycle actions; retries recheck the generation after waiting. */
  async lifecycle(taskId: string, generation: unknown, action: "stop" | "close" | "restore"): Promise<void> {
    assertDomain(!this.closed, "Terminal service is stopping", "terminal_stopping", 503);
    const row = this.row(taskId);
    this.checkGeneration(row, generation);
    const previous = this.operations.get(row.task_id);
    if (previous) {
      await previous;
      return this.lifecycle(taskId, generation, action);
    }
    const operation = Promise.resolve().then(async () => {
      if (action === "restore") {
        // Invalidate delayed close/stop requests, even before a shell is started.
        const restored = { ...row, generation: randomUUID() };
        this.database.db.transaction(() => {
          this.tasks.restoreTerminal(row.task_id);
          this.saveRow(restored);
        }).immediate();
        Object.assign(row, restored);
        return;
      }
      await this.stopLive(row.task_id);
      if (action === "close" && this.tasks.getTask(row.task_id).status !== "closed") {
        this.tasks.transition(row.task_id, { to: "closed", outcome: "cancelled" }, "user");
      }
    });
    this.operations.set(row.task_id, operation);
    try { await operation; }
    finally { if (this.operations.get(row.task_id) === operation) this.operations.delete(row.task_id); }
  }

  private async stopLive(taskId: string): Promise<void> {
    const live = this.live.get(taskId);
    if (!live) {
      // A previous backend may have exited while detached work survived. Its
      // inherited generation marker still identifies that workload safely.
      await stopTerminalProcesses(undefined, this.row(taskId).generation);
      return;
    }
    live.stopRequested = true;
    // Drain already accepted input before signalling. Further input is blocked.
    await live.parsed;
    await stopTerminalProcesses(live.owner, live.row.generation);
    if (live.row.state === "running") await live.exited;
    await live.parsed;
    if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined; }
    live.row.state = "interrupted";
    live.row.exit_code = null;
    live.row.error = "Terminal stopped. Start a new shell to continue.";
    this.persist(live);
    this.presence(live.row);
    this.wake(live);
  }

  private append(live: LiveTerminal, data: string): void {
    live.queuedBytes += data.length;
    if (live.queuedBytes > MAX_DELTA * 4) live.process.pause();
    live.parsed = live.parsed.then(() => new Promise<void>(resolve => live.screen.write(data, resolve))).then(() => {
      return live.outputMessageId ? new Promise<void>(resolve => live.outputScreen.write(data, resolve)) : undefined;
    }).then(() => {
      if (live.outputMessageId) {
        let body = screenText(live.outputScreen);
        if (live.expectedEcho && live.expectedEcho.startsWith(body)) body = "";
        else if (live.expectedEcho && body.startsWith(live.expectedEcho)) body = body.slice(live.expectedEcho.length).replace(/^\n/, "");
        if (live.atPrompt) body = body.replace(/(?:^|\n)\[[^\n]*@[^\n]*\][#$]\s*$/, "");
        this.database.db.prepare("UPDATE chat_messages SET body = ? WHERE id = ?").run(body, live.outputMessageId);
      }
      live.queuedBytes -= data.length;
      if (live.queuedBytes < MAX_DELTA) live.process.resume();
      live.row.cursor++;
      live.events.push({ cursor: live.row.cursor, data });
      live.bytes += data.length;
      while (live.bytes > MAX_DELTA && live.events.length > 1) live.bytes -= live.events.shift()!.data.length;
      this.wake(live);
      if (!live.flushTimer && !this.closed) live.flushTimer = setTimeout(() => { live.flushTimer = undefined; this.persist(live); }, 1000);
    });
  }

  async read(taskId: string, generation?: unknown, cursor?: unknown, wait = false): Promise<TerminalView> {
    let row = this.row(taskId);
    const live = this.live.get(row.task_id);
    const validCursor = typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0;
    if (live) {
      await live.parsed;
      if (wait && generation === row.generation && validCursor && cursor === live.row.cursor && row.state === "running" && !this.closed) {
        // Long poll over the existing authenticated, encrypted RPC connection.
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); live.waiters.delete(finish); resolve(); };
          const timer = setTimeout(finish, 15000);
          live.waiters.add(finish);
        });
      }
      await live.parsed;
      if (this.live.get(row.task_id) !== live) return this.read(taskId);
      row = live.row;
    }
    // A saved screen has no event buffer, but an up-to-date viewer already has
    // its snapshot. Replaying it on every poll clears the visible terminal.
    const earliestCursor = live ? (live.events[0]?.cursor ?? row.cursor + 1) - 1 : row.cursor;
    const reset = generation !== row.generation || !validCursor || cursor > row.cursor || cursor < earliestCursor;
    return {
      closed: this.tasks.getTask(row.task_id).status === "closed",
      messages: this.messages(row.task_id), screenText: live ? screenText(live.screen) : "",
      alternateScreen: live?.screen.buffer.active.type === "alternate",
      atPrompt: live?.atPrompt ?? false,
      generation: row.generation, state: row.state, cols: row.cols, rows: row.rows, cursor: row.cursor,
      reset, data: reset ? (live ? live.serializer.serialize() : row.snapshot)
        : live?.events.filter(event => event.cursor > (cursor as number)).map(event => event.data).join("") ?? "",
      exitCode: row.exit_code, error: row.error,
    };
  }

  input(taskId: string, input: { generation?: unknown; inputId?: unknown; data?: unknown; binary?: unknown; message?: unknown }): void {
    this.key(input.inputId);
    assertDomain(typeof input.data === "string" && input.data.length > 0 && input.data.length <= 32 * 1024,
      "Terminal input must be 1–32768 characters", "invalid_terminal_input");
    assertDomain(input.binary === undefined || typeof input.binary === "boolean", "Invalid input encoding", "invalid_terminal_input");
    assertDomain(input.message === undefined || (typeof input.message === "string" && input.message.length <= 30000
      && !input.binary && input.data === `${input.message.replace(/\r?\n/g, "\r")}\r`), "Invalid terminal message", "invalid_terminal_input");
    const row = this.row(taskId);
    assertDomain(input.generation === row.generation, "Shell changed. Reconnect before typing.", "terminal_generation", 409);
    // Keep identifiers only: even hashes of individual password keystrokes
    // would disclose hidden terminal input through trivial brute force.
    const receipt = this.database.db.prepare("SELECT 1 FROM terminal_input_receipts WHERE task_id = ? AND generation = ? AND input_id = ?")
      .get(row.task_id, row.generation, input.inputId);
    if (receipt) return;
    const live = this.live.get(row.task_id);
    assertDomain(live && row.state === "running" && !this.closed, "Shell is not running", "terminal_not_running", 409);
    assertDomain(!this.operations.has(row.task_id) && !live.stopRequested, "Terminal is stopping", "terminal_busy", 409);
    assertDomain(this.tasks.getTask(row.task_id).status !== "closed", "Terminal is closed", "task_closed", 409);
    // Record before handing bytes to the OS; lost acknowledgements must never
    // execute the same command twice. A server restart interrupts this generation.
    this.database.db.prepare(`INSERT INTO terminal_input_receipts (task_id, generation, input_id${this.legacyReceiptColumn ? ", data_hash" : ""}) VALUES (?, ?, ?${this.legacyReceiptColumn ? ", ''" : ""})`)
      .run(row.task_id, row.generation, input.inputId);
    const data = input.binary ? Buffer.from(input.data, "latin1") : input.data;
    live.parsed = live.parsed.then(() => {
      if (typeof input.message === "string") {
        const hidden = !live.atPrompt && !echoEnabled(live.process.pid);
        this.addMessage(row.task_id, "user", hidden ? "Hidden input" : input.message, hidden);
        live.outputMessageId = this.addMessage(row.task_id, "assistant", "");
        live.outputScreen.reset();
        live.expectedEcho = hidden ? "" : input.message.replace(/\r\n?/g, "\n");
      } else if (!live.outputMessageId) live.outputMessageId = this.addMessage(row.task_id, "assistant", "");
      if (input.data && String(input.data).includes("\r")) live.atPrompt = false;
      live.process.write(data);
      this.wake(live);
    });
  }

  async resize(taskId: string, input: { generation?: unknown; cols?: unknown; rows?: unknown }): Promise<void> {
    assertDomain(Number.isInteger(input.cols) && Number(input.cols) >= 2 && Number(input.cols) <= 500
      && Number.isInteger(input.rows) && Number(input.rows) >= 1 && Number(input.rows) <= 200,
    "Invalid terminal dimensions", "invalid_terminal_size");
    const row = this.row(taskId);
    const live = this.live.get(row.task_id);
    assertDomain(live && row.state === "running", "Shell is not running", "terminal_not_running", 409);
    assertDomain(!this.operations.has(row.task_id) && !live.stopRequested, "Terminal is stopping", "terminal_busy", 409);
    assertDomain(input.generation === row.generation, "Shell changed", "terminal_generation", 409);
    // Keep resizing ordered with screen parsing and force other viewers to resync.
    live.parsed = live.parsed.then(() => {
      if (row.cols === input.cols && row.rows === input.rows) return;
      live.screen.resize(Number(input.cols), Number(input.rows));
      live.outputScreen.resize(Number(input.cols), Number(input.rows));
      live.process.resize(Number(input.cols), Number(input.rows));
      row.cols = Number(input.cols); row.rows = Number(input.rows);
      row.cursor++;
      live.events = []; live.bytes = 0;
      this.persist(live);
      this.wake(live);
    });
    await live.parsed;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.operations.values());
    for (const live of this.live.values()) {
      if (live.flushTimer) clearTimeout(live.flushTimer);
      if (live.row.state === "running") {
        live.row.state = "interrupted";
        live.row.error = "Server restarted. Start a new shell to continue.";
        live.process.kill();
      }
      await live.parsed;
      this.persist(live);
      this.presence(live.row);
      this.wake(live);
      live.screen.dispose();
      live.outputScreen.dispose();
      this.live.delete(live.row.task_id);
    }
    this.live.clear();
  }

  private row(taskId: string): TerminalRow {
    const task = this.tasks.getTask(taskId);
    assertDomain(task.sessionKind === "terminal", "This is not a terminal conversation", "not_terminal", 409);
    const live = this.live.get(task.id);
    if (live) return live.row;
    const row = this.database.db.prepare("SELECT * FROM terminal_sessions WHERE task_id = ?").get(task.id) as TerminalRow | undefined;
    assertDomain(row, "Terminal session not found", "terminal_not_found", 404);
    return row;
  }

  private key(value: unknown): asserts value is string {
    assertDomain(typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value), "Invalid terminal request identifier", "invalid_terminal_key");
  }
  private addMessage(taskId: string, role: "user" | "assistant", body: string, hidden = false): string {
    const id = randomUUID();
    this.database.db.prepare(`INSERT INTO chat_messages (id, owner_type, owner_id, role, body, metadata_json, created_at)
      VALUES (?, 'task', ?, ?, ?, ?, ?)`)
      .run(id, taskId, role, body, JSON.stringify({ terminal: true, hiddenInput: hidden }), timestamp());
    return id;
  }
  private messages(taskId: string): ChatMessage[] {
    const rows = this.database.db.prepare(`SELECT id, role, body, metadata_json, created_at FROM chat_messages
      WHERE owner_type = 'task' AND owner_id = ? ORDER BY created_at, rowid`).all(taskId) as Array<{ id: string; role: ChatMessage["role"]; body: string; metadata_json: string | null; created_at: string }>;
    return rows.map(row => ({ id: row.id, ownerType: "task", ownerId: taskId, role: row.role, body: row.body, itemId: null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null, createdAt: row.created_at }));
  }
  private wake(live: LiveTerminal): void { for (const resolve of [...live.waiters]) resolve(); }
  private persist(live: LiveTerminal): void {
    live.row.snapshot = live.serializer.serialize();
    this.saveRow(live.row);
  }
  private saveRow(row: TerminalRow): void {
    this.database.db.prepare(`UPDATE terminal_sessions SET generation = ?, state = ?, cols = ?, rows = ?, snapshot = ?,
      cursor = ?, exit_code = ?, error = ?, updated_at = ? WHERE task_id = ?`)
      .run(row.generation, row.state, row.cols, row.rows, row.snapshot, row.cursor, row.exit_code, row.error, timestamp(), row.task_id);
  }
  private presence(row: TerminalRow): void {
    const label = row.state === "running" ? "Terminal session" : row.state === "exited" ? `Shell exited (${row.exit_code})` : row.state === "failed" ? "Shell failed to start" : "Shell interrupted";
    this.database.db.prepare("UPDATE task_presence SET message = ?, tone = ?, updated_at = ? WHERE task_id = ?")
      .run(label, row.state === "running" ? "blue" : row.state === "exited" && row.exit_code === 0 ? "neutral" : "orange", timestamp(), row.task_id);
  }
}

function processShell(): string { return process.env.SHELL || "/bin/bash"; }
function shellEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", PS1: "\\[\\e]133;A\\a\\][\\u@\\h \\W]\\$ ", PS2: "> " })
    .filter((entry): entry is [string, string] => entry[1] !== undefined
      && !/^(ORCA_|JCODE_|CODEX_(THREAD|SESSION|TOOL_CALL)_ID$|INVOCATION_ID$)/.test(entry[0])));
}

function echoEnabled(pid: number): boolean {
  const result = spawnSync("stty", ["-F", `/proc/${pid}/fd/0`, "-a"], { encoding: "utf8", timeout: 1000 });
  return result.status === 0 && !/(?:^|[;\s])-echo(?=[;\s]|$)/.test(result.stdout);
}

function screenText(screen: InstanceType<typeof Terminal>): string {
  const buffer = screen.buffer.active;
  let text = "";
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    text += (i && !line.isWrapped ? "\n" : "") + line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
  }
  return text.trimEnd();
}
