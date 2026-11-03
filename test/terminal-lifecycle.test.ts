import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { TerminalService } from "../src/server/terminal-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-terminal-lifecycle-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const config = { host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 1 };
  const database = new AppDatabase(config), tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Disposable shell", prefix: "TMP", rootDirectory: projectRoot }, "user");
  const now = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(now, now);
  return { root, projectRoot, config, database, tasks, project };
}
async function until(check: () => Promise<boolean> | boolean) {
  const end = Date.now() + 6000;
  while (!await check()) {
    assert.ok(Date.now() < end, "Terminal lifecycle condition did not arrive");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function alive(pid: number) {
  try { return !/[ZX]/.test(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]![0]!); }
  catch { return false; }
}

test("stop kills shell, foreground, background and detached descendants; isolates other terminals and starts fresh", async () => {
  const f = fixture(), service = new TerminalService(f.database, f.tasks);
  try {
    const a = await service.create(f.project.id, randomUUID(), "device");
    const otherRoot = join(f.root, "other-project"); mkdirSync(otherRoot);
    const otherProject = f.tasks.createProject({ name: "Other terminal", prefix: "OTH", rootDirectory: otherRoot }, "user");
    const b = await service.create(otherProject.id, randomUUID(), "device");
    service.input(b.task.id, { generation: b.terminal.generation, inputId: randomUUID(), data: "sleep 120 & printf '%s' $! > isolated.pid\r" });
    await until(() => { try { return Number(readFileSync(join(otherRoot, "isolated.pid"), "utf8")) > 0; } catch { return false; } });
    const isolatedPid = Number(readFileSync(join(otherRoot, "isolated.pid"), "utf8"));
    writeFileSync(join(f.projectRoot, "work.py"), `import os, signal, subprocess, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen(['sleep', '120'], start_new_session=True)
subprocess.run(['python3', '-c', "import subprocess; p = subprocess.Popen(['sleep', '120'], start_new_session=True); open('detached.pid', 'w').write(str(p.pid))"], check=True)
with open('work.pids', 'w') as out: out.write(str(os.getpid()) + ' ' + str(child.pid))
while True: time.sleep(1)
`);
    service.input(a.task.id, { generation: a.terminal.generation, inputId: randomUUID(), data: "export QAH_STOP_TEST=old; printf '%s' $$ > shell.pid; sleep 120 & printf '%s' $! > background.pid; python3 work.py\r" });
    await until(() => { try { return readFileSync(join(f.projectRoot, "work.pids"), "utf8").split(" ").length === 2; } catch { return false; } });
    const pids = ["shell.pid", "background.pid", "work.pids", "detached.pid"].flatMap(file => readFileSync(join(f.projectRoot, file), "utf8").split(" ").map(Number));
    assert.ok(pids.every(alive));
    const before = await service.read(a.task.id);
    const poll = service.read(a.task.id, before.generation, before.cursor, true);
    const stop = service.lifecycle(a.task.humanId, before.generation, "stop");
    await assert.rejects(service.start(a.task.id, before.generation), /stopping/);
    assert.throws(() => service.input(a.task.id, { generation: before.generation, inputId: randomUUID(), data: "echo late\r" }), /stopping/);
    await Promise.all([stop, service.lifecycle(a.task.id, before.generation, "stop")]);
    await poll;
    assert.ok(pids.every(pid => !alive(pid)), "Every captured owned process has stopped, including SIGTERM-resistant work");
    assert.equal((await service.read(b.task.id)).state, "running");
    assert.ok(alive(isolatedPid), "Another terminal's background workload remains alive");
    assert.equal(f.tasks.getTask(a.task.id).status, "backlog");
    const stopped = await service.read(a.task.id);
    assert.equal(stopped.state, "interrupted"); assert.match(stopped.error!, /Terminal stopped/);
    await service.start(a.task.id, stopped.generation);
    const fresh = await service.read(a.task.id);
    assert.notEqual(fresh.generation, stopped.generation);
    assert.ok(fresh.data.includes("[New shell]"));
    for (const action of ["stop", "close", "restore"] as const) await assert.rejects(service.lifecycle(a.task.id, stopped.generation, action), /Shell changed/);
    service.input(a.task.id, { generation: fresh.generation, inputId: randomUUID(), data: "printf 'FRESH:%s:%s\\n' \"${QAH_STOP_TEST-unset}\" \"$PWD\"\r" });
    await until(async () => (await service.read(a.task.id)).screenText.includes(`FRESH:unset:${f.projectRoot}`));
    assert.equal((await service.read(b.task.id)).generation, b.terminal.generation);
    service.input(b.task.id, { generation: b.terminal.generation, inputId: randomUUID(), data: "printf 'ISOLATED_STILL_WORKS\\n'\r" });
    await until(async () => /(?:^|\n)ISOLATED_STILL_WORKS(?:\n|$)/.test((await service.read(b.task.id)).screenText));
    await service.lifecycle(b.task.id, b.terminal.generation, "stop");
    assert.equal(alive(isolatedPid), false);
  } finally { await service.close(); f.database.close(); }
});

test("close retries and racing stop preserve conversation metadata; restore stays stopped and invalidates old requests", async () => {
  const f = fixture(); let service = new TerminalService(f.database, f.tasks);
  const a = await service.create(f.project.id, randomUUID(), "device");
  try {
    f.tasks.setPinned(a.task.id, true);
    service.input(a.task.id, { generation: a.terminal.generation, inputId: randomUUID(), data: "printf 'KEEP_HISTORY\\n'; sleep 120\r" });
    await until(async () => /(?:^|\n)KEEP_HISTORY(?:\n|$)/.test((await service.read(a.task.id)).screenText));
    const messages = (await service.read(a.task.id)).messages;
    await Promise.all([service.lifecycle(a.task.id, a.terminal.generation, "close"), service.lifecycle(a.task.id, a.terminal.generation, "stop"), service.lifecycle(a.task.id, a.terminal.generation, "close")]);
    const closed = f.tasks.getTask(a.task.id);
    assert.equal(closed.status, "closed"); assert.equal(closed.projectId, a.task.projectId);
    assert.ok(closed.pinnedAt); assert.equal(closed.title, a.task.title);
    assert.equal(f.tasks.listTasks({ tab: "closed" })[0]?.id, a.task.id);
    const finalMessages = (await service.read(a.task.id)).messages;
    assert.deepEqual(finalMessages.map(({ body, ...metadata }) => metadata), messages.map(({ body, ...metadata }) => metadata));
    assert.ok(finalMessages.every((message, index) => message.body.startsWith(messages[index]!.body)), "Existing output remains, with final termination output appended");
    assert.equal((await service.read(a.task.id)).closed, true);
    await assert.rejects(service.start(a.task.id), /Closed terminals/);
    await service.close();
    service = new TerminalService(f.database, f.tasks);
    const persisted = await service.read(a.task.id);
    assert.equal(persisted.closed, true); assert.ok(persisted.data.includes("KEEP_HISTORY"));
    await service.lifecycle(a.task.id, persisted.generation, "restore");
    const restored = await service.read(a.task.id);
    assert.equal(restored.closed, false); assert.equal(restored.state, "interrupted");
    assert.notEqual(restored.generation, persisted.generation);
    await assert.rejects(service.lifecycle(a.task.id, persisted.generation, "close"), /Shell changed/);
    assert.equal(f.tasks.getTask(a.task.id).status, "backlog");
    assert.equal(f.tasks.getTask(a.task.id).pinnedAt, closed.pinnedAt);
    assert.deepEqual(restored.messages, finalMessages);
    await service.start(a.task.id, restored.generation);
    assert.equal((await service.read(a.task.id)).state, "running");
  } finally { await service.close(); f.database.close(); }
});

test("lifecycle endpoints require authorization, valid origin, terminal kind and selected generation", async () => {
  const f = fixture(), app = await buildApp(f.config, f.database, { generateTitle: async () => "unused" });
  const auth = new AuthService(f.database, 1), token = auth.createSession("test", "127.0.0.1", "device").token;
  const headers = { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl };
  try {
    const a = await app.inject({ method: "POST", url: "/api/terminals", headers, payload: { projectId: f.project.id, creationKey: randomUUID() } });
    assert.equal(a.statusCode, 201);
    const { task, terminal } = a.json();
    const regular = f.tasks.createTask({ projectId: f.project.id, title: "Regular" }, "user");
    for (const action of ["stop", "close", "restore"]) {
      const request = { method: "POST" as const, url: `/api/tasks/${task.id}/terminal/${action}`, payload: { generation: terminal.generation } };
      assert.equal((await app.inject(request)).statusCode, 401);
      assert.equal((await app.inject({ ...request, headers: { ...headers, origin: "https://evil.invalid" } })).statusCode, 403);
      assert.equal((await app.inject({ ...request, headers, payload: {} })).statusCode, 400);
      assert.equal((await app.inject({ ...request, headers, payload: { generation: randomUUID() } })).statusCode, 409);
      assert.equal((await app.inject({ ...request, headers, url: `/api/tasks/${regular.id}/terminal/${action}` })).statusCode, 409);
    }
    const close = { method: "POST" as const, url: `/api/tasks/${task.humanId}/terminal/close`, headers, payload: { generation: terminal.generation } };
    const first = await app.inject(close); assert.equal(first.statusCode, 200, first.body);
    assert.equal((await app.inject(close)).statusCode, 200, "Lost close acknowledgements are safe to retry");
    assert.equal(first.json().terminal.closed, true);
    const b = (await app.inject({ method: "POST", url: "/api/terminals", headers, payload: { projectId: f.project.id, creationKey: randomUUID() } })).json();
    const revocation = setTimeout(() => auth.revokeToken(token), 60);
    const inFlight = await app.inject({ method: "POST", url: `/api/tasks/${b.task.id}/terminal/stop`, headers, payload: { generation: b.terminal.generation } });
    clearTimeout(revocation);
    assert.equal(inFlight.statusCode, 401, "Revocation also protects a shutdown response already waiting on process exit");
    assert.equal((await app.inject({ ...close, url: `/api/tasks/${task.id}/terminal/restore` })).statusCode, 401);
    assert.equal(f.tasks.getTask(task.id).status, "closed");
    assert.equal(f.tasks.getTask(regular.id).status, "backlog");
  } finally { await app.close(); }
});

test("stop after a backend restart removes surviving detached workload using persisted generation", async () => {
  const f = fixture(); let database = f.database, service = new TerminalService(database, f.tasks);
  let pid: number | undefined;
  try {
    const a = await service.create(f.project.id, randomUUID(), "device");
    writeFileSync(join(f.projectRoot, "detach.py"), `import subprocess
p = subprocess.Popen(['sleep', '120'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open('survivor.pid', 'w') as out: out.write(str(p.pid))
print('RESTART_HISTORY')
`);
    service.input(a.task.id, { generation: a.terminal.generation, inputId: randomUUID(), data: "python3 detach.py\r" });
    await until(async () => /(?:^|\n)RESTART_HISTORY(?:\n|$)/.test((await service.read(a.task.id)).screenText));
    pid = Number(readFileSync(join(f.projectRoot, "survivor.pid"), "utf8"));
    await service.close(); database.close();
    assert.ok(alive(pid), "Fixture detached workload survived the old PTY");
    database = new AppDatabase(f.config);
    service = new TerminalService(database, new TaskService(database));
    const saved = await service.read(a.task.id);
    assert.equal(saved.state, "interrupted");
    await service.lifecycle(a.task.id, saved.generation, "stop");
    assert.equal(alive(pid), false);
    assert.ok((await service.read(a.task.id)).data.includes("RESTART_HISTORY"));
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await service.close(); database.close();
  }
});

test("starting after natural shell exit cleans previous detached work and prevents duplicate starts", async () => {
  const f = fixture(), service = new TerminalService(f.database, f.tasks);
  let pid: number | undefined;
  try {
    const a = await service.create(f.project.id, randomUUID(), "device");
    writeFileSync(join(f.projectRoot, "natural-exit.py"), `import subprocess
p = subprocess.Popen(['sleep', '120'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open('natural.pid', 'w') as out: out.write(str(p.pid))
`);
    service.input(a.task.id, { generation: a.terminal.generation, inputId: randomUUID(), data: "python3 natural-exit.py; exit\r" });
    await until(async () => (await service.read(a.task.id)).state === "exited");
    pid = Number(readFileSync(join(f.projectRoot, "natural.pid"), "utf8"));
    assert.ok(alive(pid));
    const start = service.start(a.task.id, a.terminal.generation);
    await assert.rejects(service.start(a.task.id, a.terminal.generation), /stopping/);
    await start;
    assert.equal(alive(pid), false);
    const current = await service.read(a.task.id);
    assert.equal(current.state, "running"); assert.notEqual(current.generation, a.terminal.generation);
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await service.close(); f.database.close();
  }
});
