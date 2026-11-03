import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService, type CapacitySnapshot } from "../../src/server/agent-service.js";
import { AttachmentService } from "../../src/server/attachment-service.js";
import { AppDatabase } from "../../src/server/database.js";
import { TaskService } from "../../src/server/task-service.js";

class ControlledAgents extends AgentService {
  limit = 4;
  override capacity(): CapacitySnapshot {
    const snapshot = super.capacity();
    const limit = this.limit ?? 0;
    return { ...snapshot, recommendedParallelism: limit, availableSlots: Math.max(0, limit - snapshot.activeTurns) };
  }
}

export async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Real SQLite and app-server transport; fake Codex never invokes a model or tools.
export function coordinationFixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-replies-"));
  const capture = join(root, "requests.jsonl");
  const events = join(root, "events.json");
  const settings = join(root, "settings.json");
  writeFileSync(capture, "");
  writeFileSync(settings, "{}");
  writeFileSync(join(root, "codex"), `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let sequence = 0;
const activeTurns = new Map();
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  if (request.id === undefined) return;
  const settings = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, "utf8"));
  const currentAtRequest = settings.currentTurnId === undefined ? activeTurns.get(request.params?.threadId) : settings.currentTurnId;
  const respond = () => {
    if (request.method === settings.reject) return send({ id: request.id, error: { code: settings.rejectCode, message: settings.rejectMessage || "The task connection was lost" } });
    let result = {};
    if (request.method === "thread/start") result = { thread: { id: "thread-" + process.pid + "-" + ++sequence } };
    if (request.method === "turn/start") {
      result = { turn: { id: "turn-" + process.pid + "-" + ++sequence } };
      activeTurns.set(request.params.threadId, result.turn.id);
    }
    if (request.method === "turn/steer") {
      if (!request.params.expectedTurnId) return send({ id: request.id, error: { code: -32600, message: "Invalid request: missing field expectedTurnId" } });
      const current = currentAtRequest;
      if (request.params.expectedTurnId !== current) return send({ id: request.id, error: { code: -32600, message: current ? "expectedTurnId does not match active turn" : "no active turn" } });
      if (settings.disconnect) return process.exit(0);
      result = { turnId: settings.ackTurnId || current };
    }
    send({ id: request.id, result });
  };
  setTimeout(respond, request.method === "turn/steer" ? settings.delay || 0 : 0);
});
setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(events)})) return;
  const batch = JSON.parse(fs.readFileSync(${JSON.stringify(events)}, "utf8"));
  fs.unlinkSync(${JSON.stringify(events)});
  for (const event of batch) {
    if (event.method === "turn/completed") activeTurns.delete(event.params.threadId);
    send(event);
  }
}, 5);
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  const database = new AppDatabase({ host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost",
    dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 });
  const tasks = new TaskService(database);
  const attachments = new AttachmentService(database, join(root, "attachments"));
  let agents = new ControlledAgents(database, tasks, attachments);
  let nextItem = 0;
  const writeJson = (path: string, value: unknown) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(value));
    renameSync(`${path}.tmp`, path);
  };
  return {
    root, database, tasks,
    get agents() { return agents; },
    restart() { agents.close(); agents = new ControlledAgents(database, tasks, attachments); },
    emit(batch: unknown[]) { writeJson(events, batch); },
    task(title = "Fix the canvas preview", projectId?: string) {
      const project = projectId ? { id: projectId } : tasks.createProject({ name: "Qahwa", prefix: `R${nextItem++}`, rootDirectory: root }, "user");
      return tasks.createTask({ projectId: project.id, title, status: "todo" }, "user");
    },
    settings(value: { reject?: string; rejectCode?: number; rejectMessage?: string; delay?: number; currentTurnId?: string | null; ackTurnId?: string; disconnect?: boolean }) { writeJson(settings, value); },
    requests(): Array<{ method?: string; params: any }> {
      return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    workspace() { return agents.workspace("orchestrator", "main"); },
    assistants() { return agents.workspace("orchestrator", "main").messages.filter(({ role }) => role === "assistant"); },
    async reply(raw: string, authorization = "Send guidance and prioritize the canvas task", role: "user" | "system" = "user") {
      await agents.send("orchestrator", "main", authorization, false, role);
      const { threadId, activeTurnId: turnId } = agents.workspace("orchestrator", "main").session;
      const itemId = `reply-${nextItem++}`;
      writeJson(events, [
        { method: "item/completed", params: { threadId, turnId, item: { id: itemId, type: "agentMessage", phase: "final_answer", text: raw } } },
      ]);
      await until(() => Boolean(database.db.prepare("SELECT 1 FROM session_events WHERE event_type = 'item/completed' AND payload_json LIKE ?").get(`%${itemId}%`)), "Reply event did not arrive");
      return itemId;
    },
    close() {
      agents.close(); attachments.close(); database.close();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
