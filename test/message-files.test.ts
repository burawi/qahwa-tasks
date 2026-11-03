import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ChatMessage, SessionOwnerType } from "../src/domain/types.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { deliveredFileLinks, localDeliveryPath, MessageFiles } from "../src/server/message-files.js";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { workspacePoll } from "../src/server/workspace-poll.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "qahwa-message-files-"));
  const root = join(directory, "project");
  const outside = join(directory, "outside");
  mkdirSync(root); mkdirSync(outside);
  const config = { host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", dataDir: join(directory, "data"), backupDir: join(directory, "backup"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Preview fixtures", prefix: "FILE", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "File delivery", status: "todo" }, "user");
  const other = tasks.createTask({ projectId: project.id, title: "Other chat", status: "todo" }, "user");
  const files = new MessageFiles(database, root);
  const write = (name: string, content = "Original deliverable") => { const path = join(root, name); writeFileSync(path, content); return path; };
  const message = (mode: SessionOwnerType, body: string, overrides: Partial<ChatMessage> = {}): ChatMessage => {
    const saved: ChatMessage = { id: randomUUID(), ownerType: mode, ownerId: mode === "task" ? task.id : "main", role: "assistant", body,
      itemId: null, metadata: { preserved: "yes", designPageId: null }, createdAt: new Date().toISOString(), ...overrides };
    database.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at,version,edited_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(saved.id, saved.ownerType, saved.ownerId, saved.role, saved.body, JSON.stringify(saved.metadata), saved.createdAt, 3, "2026-01-01T00:00:00.000Z");
    return saved;
  };
  const count = () => (database.db.prepare("SELECT count(*) AS n FROM message_files").get() as { n: number }).n;
  const savedRows = () => database.db.prepare("SELECT * FROM chat_messages ORDER BY rowid").all();
  return { directory, root, outside, config, database, tasks, task, other, files, write, message, count, savedRows,
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("only real Markdown file deliveries are candidates; source references and remote/config paths stay untouched", () => {
  const links = deliveredFileLinks("[Report](<reports/a b.pdf>) ![Photo](images/p.png) [Again](images/p.png) [Ref][file]\n\n[file]: notes.txt\n\n`[example](private.txt)`\n\n```md\n[example](private.pdf)\n```\n\nBare /project/secret.pdf");
  assert.deepEqual(links, ["reports/a b.pdf", "images/p.png", "notes.txt"]);
  for (const value of ["/etc/passwd", ".env", ".git/config.json", "node_modules/a/readme.md", "/project/file.txt:5", "/project/file.txt#L5", "file://remote/file.pdf", "https://example.com/report.pdf", "//evil/x.pdf", "../.private/report.pdf", "/project/%00.pdf", "bad%GG.pdf"]) assert.equal(localDeliveryPath(value), null, value);
  assert.equal(localDeliveryPath("file:///project/a%20b.pdf"), "/project/a b.pdf");
  assert.equal(localDeliveryPath("sandbox:/project/report.pdf"), "/project/report.pdf");
});

for (const mode of ["task", "orchestrator"] as const) {
  test(`${mode}: older deliveries repair without changing message history, review outputs, metadata, or task state`, () => {
    const f = fixture();
    try {
      const path = f.write("a b.txt");
      const body = `[Report](<${path}>)\n\n[Again](file://${path.replaceAll(" ", "%20")})\n\n[Ref][file]\n\n[file]: sandbox:${path.replaceAll(" ", "%20")}`;
      const message = f.message(mode, body);
      const history = f.savedRows();
      const before = f.tasks.getTask(f.task.id);
      const first = f.files.decorate(message);
      assert.equal(first.body, body);
      assert.equal(first.metadata?.preserved, "yes");
      assert.equal(first.metadata?.files?.length, 3);
      const urls = new Set(first.metadata!.files!.map(file => file.previewUrl));
      assert.equal(urls.size, 1, "aliases reuse a registration");
      assert.ok([...urls][0]?.startsWith(mode === "task" ? `/api/tasks/${f.task.id}/files/` : "/api/orchestrator/files/"));
      assert.equal(first.metadata!.files![0]!.previewKind, "text");
      for (let i = 0; i < 3; i++) f.files.decorate(message);
      const second = f.message(mode, `[Repeat](<${path}>)`);
      assert.equal(f.files.decorate(second).metadata?.files?.[0]?.previewUrl, [...urls][0]);
      assert.equal(f.count(), 1, "polls, aliases, and repeated deliveries do not duplicate registrations");
      assert.deepEqual(f.savedRows().slice(0, history.length), history);
      assert.deepEqual(f.tasks.getTask(f.task.id), before);
      const reopened = new MessageFiles(f.database, f.root);
      const row = reopened.decorate(message).metadata!.files![0]!;
      const file = reopened.open(mode, mode === "task" ? f.task.id : "main", row.previewUrl!.split("/").at(-1)!);
      try { assert.equal(readFileSync(file.fd, "utf8"), "Original deliverable"); } finally { closeSync(file.fd); }
    } finally { f.close(); }
  });

  test(`${mode}: missing, newer, outside-root, symlink, ambiguous and code-example paths are not repaired`, () => {
    const f = fixture();
    try {
      const good = f.write("good.pdf");
      const newer = f.write("newer.pdf");
      const directory = join(f.root, "directory.pdf"); mkdirSync(directory);
      const external = join(f.outside, "outside.pdf"); writeFileSync(external, "outside");
      symlinkSync(external, join(f.root, "escape.pdf"));
      mkdirSync(join(f.root, ".private")); writeFileSync(join(f.root, ".private", "secret.pdf"), "private");
      symlinkSync(join(f.root, ".private", "secret.pdf"), join(f.root, "hidden.pdf"));
      const body = `[Good](${good}) [Newer](${newer}) [Missing](${join(f.root, "missing.pdf")}) [Directory](${directory}) [Outside](${external}) [Traversal](../outside/outside.pdf) [Escape](${join(f.root, "escape.pdf")}) [Hidden](${join(f.root, "hidden.pdf")}) [Line](${good}:4)\n\n\`[Example](${newer})\``;
      const message = f.message(mode, body);
      utimesSync(newer, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      assert.deepEqual(f.files.decorate(message).metadata?.files?.map(file => file.filename), ["good.pdf"]);
      f.write("missing.pdf");
      assert.equal(f.files.decorate(message).metadata?.files?.length, 1, "missing files do not appear later in older messages");
      assert.equal(f.count(), 1);
      const user = f.message(mode, `[Private user reference](${newer})`, { role: "user" });
      assert.equal(f.files.decorate(user).metadata?.files, undefined, "user links cannot register host files");
    } finally { f.close(); }
  });

  test(`${mode}: changed/deleted/replaced files reject download; explicit newer deliveries get a new registration`, async () => {
    const f = fixture();
    try {
      const path = f.write("report.txt");
      const message = f.message(mode, `[Report](${path})`);
      const url = f.files.decorate(message).metadata!.files![0]!.previewUrl!;
      const id = url.split("/").at(-1)!;
      await new Promise(resolve => setTimeout(resolve, 5));
      f.write("report.txt", "Revised deliverable");
      assert.equal(f.files.decorate(message).metadata?.files?.[0]?.previewUrl, null);
      assert.throws(() => f.files.open(mode, mode === "task" ? f.task.id : "main", id), /changed/);
      const next = f.files.decorate(f.message(mode, `[Revised](${path})`));
      assert.notEqual(next.metadata?.files?.[0]?.previewUrl, url);
      assert.equal(f.count(), 2);
      rmSync(path);
      assert.equal(f.files.decorate(message).metadata?.files?.[0]?.previewUrl, null);
      symlinkSync(join(f.outside, "replacement.txt"), path);
      writeFileSync(join(f.outside, "replacement.txt"), "Must not be served");
      assert.throws(() => f.files.open(mode, mode === "task" ? f.task.id : "main", id), /changed/);
    } finally { f.close(); }
  });
}

test("paired routes serve exact bytes, bounded ranges and downloads; authentication and chat boundaries remain enforced", async () => {
  const f = fixture();
  const app = await buildApp(f.config, f.database);
  try {
    const stamp = new Date().toISOString();
    f.database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Fixture','',?,?)").run(stamp, stamp);
    const token = new AuthService(f.database, 365).createSession("Fixture", "127.0.0.1", "device").token;
    const headers = { authorization: `Bearer ${token}` };
    for (const mode of ["task", "orchestrator"] as const) {
      const path = f.write(`${mode}.json`, '{"safe":"preview"}');
      const message = f.message(mode, `[Data](${path})`);
      const url = f.files.decorate(message).metadata!.files![0]!.previewUrl!;
      assert.equal((await app.inject({ url })).statusCode, 401);
      const downloaded = await app.inject({ url: url + "?download=1", headers });
      assert.equal(downloaded.statusCode, 200, downloaded.body);
      assert.equal(downloaded.body, '{"safe":"preview"}');
      assert.match(downloaded.headers["content-disposition"]!, /^attachment;/);
      assert.equal(downloaded.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'self'; sandbox");
      const partial = await app.inject({ url, headers: { ...headers, range: "bytes=2-5" } });
      assert.equal(partial.statusCode, 206); assert.equal(partial.body, 'safe');
      assert.equal((await app.inject({ url, headers: { ...headers, range: "bytes=500-600" } })).statusCode, 416);
      const suffix = await app.inject({ url, headers: { ...headers, range: "bytes=-2" } });
      assert.equal(suffix.body, '"}');
      const wrong = mode === "task" ? url.replace(f.task.id, f.other.id) : url.replace("/api/orchestrator", `/api/tasks/${f.task.id}`);
      assert.equal((await app.inject({ url: wrong, headers })).statusCode, 404);
      if (mode === "task") assert.equal((await app.inject({ url: url.replace(f.task.id, f.task.humanId), headers })).statusCode, 200);
      f.database.db.prepare("UPDATE chat_messages SET cancelled_at=? WHERE id=?").run(stamp, message.id);
      assert.equal((await app.inject({ url, headers })).statusCode, 404);
      const empty = f.message(mode, `[Empty](${f.write(`${mode}-empty.txt`, "")})`);
      const emptyUrl = f.files.decorate(empty).metadata!.files![0]!.previewUrl!;
      const response = await app.inject({ url: emptyUrl, headers: { ...headers, range: "bytes=0-262143" } });
      assert.equal(response.statusCode, 200); assert.equal(response.rawPayload.length, 0);
    }
  } finally { await app.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("completed progress and final messages in both modes register immediately, survive polling, and never execute progress actions", async () => {
  const f = fixture();
  const attachments = new AttachmentService(f.database);
  const agents = new AgentService(f.database, f.tasks, attachments);
  // Exercise the actual app-server event entry point without starting Codex or a model.
  try {
    const events = agents as unknown as { handleCodexMessage(message: unknown): void; developerInstructions(mode: SessionOwnerType, id: string, state: "ready"): string; prompt(mode: SessionOwnerType, id: string, text: string, initial: boolean): string };
    for (const mode of ["task", "orchestrator"] as const) {
      const ownerId = mode === "task" ? f.task.id : "main";
      agents.workspace(mode, ownerId);
      const threadId = `thread-${mode}`, turnId = `turn-${mode}`;
      f.database.db.prepare("UPDATE agent_sessions SET thread_id=?, active_turn_id=?,run_state='running',intake_state='ready' WHERE owner_type=? AND owner_id=?").run(threadId, turnId, mode, ownerId);
      for (const phase of ["commentary", "final_answer"]) {
        const file = f.write(`${mode}-${phase}.txt`);
        const item = { id: `${mode}-${phase}`, type: "agentMessage", phase, text: `[File](${file})\n<!-- qahwa:{"message":"Check","tone":"blue","surface":"chat","review":${phase === "commentary"}} -->` };
        const before = agents.workspace(mode, ownerId);
        const cursor = workspacePoll(before, {});
        events.handleCodexMessage({ method: "item/completed", params: { threadId, turnId, item } });
        events.handleCodexMessage({ method: "item/completed", params: { threadId, turnId, item } });
        const after = agents.workspace(mode, ownerId);
        const messages = after.messages.filter(message => message.itemId === item.id);
        assert.equal(messages.length, 1, "replayed events do not duplicate messages");
        assert.equal(messages[0]!.metadata?.files?.length, 1);
        assert.doesNotMatch(messages[0]!.body, /qahwa:/);
        assert.notEqual(workspacePoll(after, cursor).messagesRevision, cursor.messagesRevision);
        assert.equal(f.tasks.getTask(f.task.id).status, "todo", "commentary review markers have no lifecycle side effects");
      }
      assert.match(events.developerInstructions(mode, ownerId, "ready"), /in-chat preview and Download controls in both progress and final/);
      assert.match(events.prompt(mode, ownerId, "Deliver the file", false), /automatically registers existing files/);
      assert.equal(f.tasks.getTask(f.task.id).outputs.length, 0);
    }
  } finally { agents.close(); attachments.close(); f.close(); }
});
