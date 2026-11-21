import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import { assertDomain, DomainError } from "../domain/errors.js";
import type { TaskAccessMode } from "../domain/types.js";

export interface OpenCodeProfileRoots {
  config: string;
  data: string;
  cache: string;
  state: string;
  temp: string;
}

export interface OpenCodeClone {
  root: string;
  roots: OpenCodeProfileRoots;
  environment: NodeJS.ProcessEnv;
}

const rootPaths = (root: string): OpenCodeProfileRoots => ({
  config: join(root, "config", "opencode"),
  data: join(root, "data", "opencode"),
  cache: join(root, "cache", "opencode"),
  state: join(root, "state", "opencode"),
  temp: join(root, "tmp", "opencode"),
});

export function currentOpenCodeRoots(environment: NodeJS.ProcessEnv = process.env): OpenCodeProfileRoots {
  const home = environment.HOME || homedir();
  return {
    config: join(environment.XDG_CONFIG_HOME || join(home, ".config"), "opencode"),
    data: join(environment.XDG_DATA_HOME || join(home, ".local", "share"), "opencode"),
    cache: join(environment.XDG_CACHE_HOME || join(home, ".cache"), "opencode"),
    state: join(environment.XDG_STATE_HOME || join(home, ".local", "state"), "opencode"),
    temp: join(environment.TMPDIR || tmpdir(), "opencode"),
  };
}

function copyTree(source: string, destination: string, skipDatabase = false): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
    filter: (path) => {
      const name = basename(path);
      if (skipDatabase && ["opencode.db", "opencode.db-wal", "opencode.db-shm"].includes(name)) return false;
      try { return !lstatSync(path).isSocket(); } catch { return false; }
    },
  });
}

/** Creates the clone once. Existing clones are never refreshed implicitly. */
export async function ensureOpenCodeClone(dataDir: string, source = currentOpenCodeRoots()): Promise<OpenCodeClone> {
  const root = join(dataDir, "opencode-profile");
  const ready = join(root, "clone-manifest.json");
  if (!existsSync(ready)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(dataDir, ".opencode-profile-"));
    chmodSync(staging, 0o700);
    const target = rootPaths(staging);
    try {
      copyTree(source.config, target.config);
      copyTree(source.data, target.data, true);
      copyTree(source.cache, target.cache);
      copyTree(source.state, target.state);
      copyTree(source.temp, target.temp);
      const sourceDatabase = join(source.data, "opencode.db");
      if (existsSync(sourceDatabase)) {
        mkdirSync(target.data, { recursive: true, mode: 0o700 });
        const database = new Database(sourceDatabase, { readonly: true, fileMustExist: true });
        try { await database.backup(join(target.data, "opencode.db")); } finally { database.close(); }
      }
      writeFileSync(join(staging, "clone-manifest.json"), JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        sources: source,
      }, null, 2), { mode: 0o600 });
      try { renameSync(staging, root); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && existsSync(ready)) rmSync(staging, { recursive: true, force: true });
        else throw error;
      }
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const roots = rootPaths(root);
  return {
    root,
    roots,
    environment: {
      ...process.env,
      XDG_CONFIG_HOME: dirname(roots.config),
      XDG_DATA_HOME: dirname(roots.data),
      XDG_CACHE_HOME: dirname(roots.cache),
      XDG_STATE_HOME: dirname(roots.state),
      TMPDIR: dirname(roots.temp),
    },
  };
}

export interface OpenCodeRunInput {
  ownerKey: string;
  cwd: string;
  prompt: string;
  sessionId: string | null;
  accessMode: TaskAccessMode;
  unrestricted?: boolean;
  model?: string;
  attachments?: string[];
}

export interface OpenCodeRunResult {
  sessionId: string;
  messageId: string;
  text: string;
}

export interface OpenCodeStartedRun {
  sessionId: string;
  messageId: string;
  completion: Promise<OpenCodeRunResult>;
}

interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  messageID?: string;
  part?: { id?: string; text?: string; type?: string; tool?: string; state?: { title?: string; output?: string; error?: string } };
}

export class OpenCodeRuntime {
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  private clone: Promise<OpenCodeClone> | null = null;

  constructor(private readonly dataDir: string, private readonly onEvent?: (ownerKey: string, event: OpenCodeEvent) => void) {}

  async run(input: OpenCodeRunInput): Promise<OpenCodeRunResult> {
    const started = await this.start(input);
    return started.completion;
  }

  /**
   * Spawns OpenCode and resolves as soon as the runtime has accepted the
   * prompt. The turn keeps running in the background through `completion`, so
   * callers can clear the composer without waiting for the whole turn.
   */
  async start(input: OpenCodeRunInput): Promise<OpenCodeStartedRun> {
    assertDomain(!this.running.has(input.ownerKey), "OpenCode is already running for this conversation", "opencode_already_running", 409);
    this.clone ??= ensureOpenCodeClone(this.dataDir).catch(error => { this.clone = null; throw error; });
    const clone = await this.clone;
    const args = ["run", "--format", "json", "--dir", input.cwd];
    if (input.sessionId) args.push("--session", input.sessionId);
    if (input.model) args.push("--model", input.model);
    for (const attachment of input.attachments ?? []) args.push("--file", attachment);
    const permission = input.accessMode === "read-only"
      ? { "*": "allow", edit: "deny", bash: "deny", external_directory: "deny" }
      : input.unrestricted ? { "*": "allow" } : { "*": "allow", external_directory: "deny" };
    const child = spawn("opencode", args, {
      cwd: input.cwd,
      env: { ...clone.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission }) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.running.set(input.ownerKey, child);
    const textParts: string[] = [];
    let sessionId = input.sessionId ?? "";
    let messageId = "";
    let stderr = "";
    let accepted = false;
    let settled = false;
    let resolveAccept!: (value: { sessionId: string; messageId: string }) => void;
    let rejectAccept!: (error: unknown) => void;
    const acceptedRun = new Promise<{ sessionId: string; messageId: string }>((resolve, reject) => {
      resolveAccept = resolve;
      rejectAccept = reject;
    });
    let resolveCompletion!: (value: OpenCodeRunResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<OpenCodeRunResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A caller that never observes completion (for example because acceptance
    // itself failed) must not produce an unhandled rejection.
    void completion.catch(() => undefined);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const event = JSON.parse(line) as OpenCodeEvent;
        if (event.sessionID) sessionId = event.sessionID;
        if (event.messageID) messageId = event.messageID;
        if (event.part?.id && !messageId) messageId = event.part.id;
        if (event.type === "text" && typeof event.part?.text === "string") textParts.push(event.part.text);
        this.onEvent?.(input.ownerKey, event);
        if (!accepted && sessionId) {
          accepted = true;
          resolveAccept({ sessionId, messageId });
        }
      } catch { /* ignore non-event diagnostics */ }
    });
    child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    const finish = (code: number | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      this.running.delete(input.ownerKey);
      lines.close();
      if (error) {
        if (!accepted) rejectAccept(error);
        rejectCompletion(error);
        return;
      }
      if (!accepted) {
        const failure = new DomainError(stderr.trim() || `OpenCode stopped with exit code ${code}`, "opencode_run_failed", 503);
        rejectAccept(failure);
        rejectCompletion(failure);
        return;
      }
      if (code !== 0) {
        rejectCompletion(new DomainError(stderr.trim() || `OpenCode stopped with exit code ${code}`, "opencode_run_failed", 503));
        return;
      }
      assertDomain(sessionId, "OpenCode did not report a session identifier", "opencode_session_failed", 503);
      resolveCompletion({ sessionId, messageId: messageId || `opencode-${randomUUID()}`, text: textParts.join("").trim() });
    };
    child.once("error", error => finish(null, error));
    child.once("exit", code => finish(code));
    child.stdin.end(input.prompt);
    const acceptedValue = await acceptedRun;
    return { ...acceptedValue, completion };
  }

  interrupt(ownerKey: string): boolean {
    const child = this.running.get(ownerKey);
    if (!child) return false;
    this.stop(child);
    return true;
  }

  close(): void {
    for (const child of this.running.values()) this.stop(child);
    this.running.clear();
  }

  private stop(child: ChildProcessWithoutNullStreams): void {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { child.kill("SIGTERM"); }
  }
}
