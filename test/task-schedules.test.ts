import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentService, type CapacitySnapshot } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import { workspacePoll } from "../src/server/workspace-poll.js";

class ControlledAgents extends AgentService {
  limit = 0;
  override capacity(): CapacitySnapshot {
    const snapshot = super.capacity();
    const limit = this.limit ?? 0;
    return { ...snapshot, recommendedParallelism: limit, availableSlots: Math.max(0, limit - snapshot.activeTurns) };
  }
}

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-scheduled-"));
  const capture = join(root, "requests.jsonl");
  const control = join(root, "control.json");
  const settings = join(root, "settings.json");
  writeFileSync(settings, "{}");
  writeFileSync(capture, "");
  // No model calls: turns stay active until the test sends completion events.
  writeFileSync(join(root, "codex"), `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let sequence = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  if (request.id === undefined) return;
  const settings = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, "utf8"));
  if (request.method === "turn/start" && settings.reject) {
    send({ id: request.id, error: { message: "Temporary start failure" } }); return;
  }
  let result = {};
  if (request.method === "thread/start") result = { thread: { id: "thread-" + ++sequence } };
  if (request.method === "turn/start") result = { turn: { id: "turn-" + ++sequence } };
  setTimeout(() => send({ id: request.id, result }), request.method === "turn/start" ? settings.delay || 0 : 0);
});
setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(control)})) return;
  const events = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
  fs.unlinkSync(${JSON.stringify(control)});
  for (const event of events) send(event);
}, 5);
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  let database = new AppDatabase(config);
  let tasks = new TaskService(database);
  const timestamp = new Date().toISOString();
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('device', 'Test', '', ?, ?)").run(timestamp, timestamp);
  let attachments = new AttachmentService(database, join(root, "temporary"));
  let agents = new ControlledAgents(database, tasks, attachments);
  const f = {
    root, config,
    get database() { return database; }, get tasks() { return tasks; },
    get attachments() { return attachments; }, get agents() { return agents; },
    task(prefix: string, projectId?: string) {
      const project = projectId ? { id: projectId } : tasks.createProject({ name: prefix, prefix, rootDirectory: root }, "user");
      return tasks.createTask({ projectId: project.id, title: `Work ${prefix}`, status: "todo" }, "user");
    },
    settings(value: { reject?: boolean; delay?: number }) { writeFileSync(settings, JSON.stringify(value)); },
    requests(): Array<{ method?: string; params: any }> {
      return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    turns() { return f.requests().filter((request) => request.method === "turn/start"); },
    async tick() { await Reflect.get(agents, "monitorPortfolio").call(agents); },
    async started(type: "task" | "orchestrator", id: string) {
      await until(() => Boolean(agents.workspace(type, id).session.activeTurnId), `Turn for ${type}/${id} did not start`);
    },
    async complete(type: "task" | "orchestrator", id: string, text = "<!-- qahwa-silent -->") {
      const { threadId, activeTurnId: turnId } = agents.workspace(type, id).session;
      assert.ok(turnId);
      writeFileSync(control, JSON.stringify([
        { method: "item/completed", params: { threadId, turnId, item: { id: `item-${turnId}`, type: "agentMessage", phase: "final_answer", text } } },
        { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
      ]));
      await until(() => agents.workspace(type, id).session.activeTurnId !== turnId, "Completion did not arrive");
    },
    restart() {
      agents.close(); attachments.close(); database.close();
      database = new AppDatabase(config); tasks = new TaskService(database);
      attachments = new AttachmentService(database, join(root, "temporary"));
      agents = new ControlledAgents(database, tasks, attachments);
    },
    close() {
      agents.close(); attachments.close(); database.close();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}


import { resolveScheduleTime } from "../src/domain/schedule-time.js";
import { TaskCreationService } from "../src/server/task-creation-service.js";
import { randomUUID } from "node:crypto";

function schedule(f: ReturnType<typeof fixture>, id: string, policy = "when_available") {
  return f.agents.saveSchedule(id, { expectedVersion: 0, localTime: "2099-10-31T14:30", timezone: "Africa/Tunis", policy }).schedule!;
}
function due(f: ReturnType<typeof fixture>, id: string, offset = 0) {
  f.database.db.prepare("UPDATE task_schedules SET run_at=? WHERE task_id=?").run(new Date(Date.now() + offset).toISOString(), id);
}

test("wall times resolve absolute instants and reject invalid dates, DST gaps and folds", () => {
  assert.equal(resolveScheduleTime("2027-01-01T12:00", "Africa/Tunis"), "2027-01-01T11:00:00.000Z");
  assert.equal(resolveScheduleTime("2027-01-01T12:00", "Asia/Kathmandu"), "2027-01-01T06:15:00.000Z");
  assert.throws(() => resolveScheduleTime("2027-02-30T12:00", "UTC"));
  assert.throws(() => resolveScheduleTime("2027-03-14T02:30", "America/New_York"), /does not exist/);
  assert.throws(() => resolveScheduleTime("2027-11-07T01:30", "America/New_York"), /twice/);
  assert.throws(() => resolveScheduleTime("2027-01-01T12:00", "Invalid/Zone"));
});

test("schedule edits and removal use versions, preserve the task and prevent early/manual starts", async () => {
  const f = fixture();
  try {
    const task = f.task("SCH"); const original = f.tasks.getTask(task.id);
    const saved = schedule(f, task.humanId);
    assert.equal(saved.state, "pending"); assert.equal(saved.timezone, "Africa/Tunis");
    await f.tick(); assert.equal(f.turns().length, 0);
    await assert.rejects(f.agents.triggerTask(task.id), /Remove the schedule/);
    await assert.rejects(f.agents.send("task", task.id, "Start"), /Remove the schedule/);
    assert.throws(() => f.agents.saveSchedule(task.id, {expectedVersion: 0}), /changed/);
    const edit = f.agents.saveSchedule(task.id, {expectedVersion: saved.version, localTime:"2099-11-01T16:00",timezone:"UTC",policy:"skip_if_missed"}).schedule!;
    assert.equal(edit.version, 2);
    assert.throws(() => f.agents.cancelSchedule(task.id, saved.version), /changed/);
    f.agents.cancelSchedule(task.id, edit.version);
    assert.equal(f.agents.workspace("task",task.id).schedule?.state, "cancelled");
    const after=f.tasks.getTask(task.id);
    assert.deepEqual({...after,lastActivityAt:null}, {...original,lastActivityAt:null});
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM task_schedule_history WHERE task_id=?").get(task.id).n, 3);
    schedule(f, f.task("SECOND").id);
    assert.throws(() => f.agents.saveSchedule(task.id, { expectedVersion:3,localTime:"2000-01-01T00:00",timezone:"UTC",policy:"when_available"}), /future/);
  } finally { f.close(); }
});

test("skip window includes exactly sixty seconds and never reserves early", () => {
  const f=fixture();
  try {
    const task=f.task("BOUND"), saved=schedule(f,task.id,"skip_if_missed"), at=Date.parse(saved.runAt);
    const schedules=f.agents.schedules;
    assert.equal(schedules.reserve(task.id,saved.version,at-1),false);
    assert.equal(schedules.due(at-1).length,0);
    assert.equal(schedules.due(at).length,1);
    assert.equal(schedules.due(at+60_000).length,1);
    assert.equal(schedules.reserve(task.id,saved.version,at+60_000),true);
    assert.equal(schedules.reserve(task.id,saved.version,at+60_000),false);
    assert.throws(()=>f.agents.cancelSchedule(task.id,saved.version), /changed/);
    assert.throws(()=>f.agents.cancelSchedule(task.id,saved.version+1), /reserved/);
    const other=f.task("LATE"), late=schedule(f,other.id,"skip_if_missed");
    assert.equal(schedules.due(Date.parse(late.runAt)+60_001).length,0);
    assert.equal(schedules.get(other.id)?.state,"skipped");
    assert.equal(f.tasks.getTask(other.id).status,"todo");
  } finally {f.close();}
});

test("downtime recovery waits for capacity, skips expired schedules and dispatches once through intake", async () => {
  const f=fixture();
  try {
    const task=f.task("REC"), expired=f.task("MISS");
    schedule(f,task.id); schedule(f,expired.id,"skip_if_missed"); due(f,task.id,-120_000); due(f,expired.id,-60_001);
    f.restart(); await f.tick();
    assert.equal(f.agents.schedules.get(task.id)?.state,"pending");
    assert.equal(f.agents.schedules.get(expired.id)?.state,"skipped");
    assert.equal(f.turns().length,0);
    f.agents.limit=1;
    await Promise.all([f.tick(),f.tick(),f.tick()]);
    assert.equal(f.turns().length,1);
    assert.equal(f.agents.schedules.get(task.id)?.state,"started");
    assert.equal(f.agents.workspace("task",task.id).session.intakeState,"pending");
    const start=f.requests().find(r=>r.method==="thread/start")!;
    assert.equal(start.params.sandbox,"read-only");
    assert.match(f.turns()[0]!.params.input[0].text,/intake/i);
    f.restart(); f.agents.limit=1; await f.tick();
    assert.equal(f.turns().length,1);
    assert.equal(f.agents.workspace("task",task.id).session.runState,"interrupted");
  } finally {f.close();}
});

test("reservation wins editing/cancellation races and failed starts never retry automatically", async () => {
  const f=fixture();
  try {
    const task=f.task("RACE"), saved=schedule(f,task.id); due(f,task.id); f.settings({delay:150}); f.agents.limit=1;
    const tick=f.tick();
    await until(()=>f.agents.schedules.get(task.id)?.state==="reserved","No reservation");
    assert.throws(()=>f.agents.cancelSchedule(task.id,saved.version), /changed/);
    assert.throws(()=>f.agents.saveSchedule(task.id,{expectedVersion:saved.version+1}), /reserved/);
    await tick; await until(()=>f.agents.schedules.get(task.id)?.state==="started","No scheduled turn"); assert.equal(f.turns().length,1);
    f.restart();
    const fail=f.task("FAIL"); schedule(f,fail.id); due(f,fail.id); f.settings({reject:true}); f.agents.limit=1;
    await f.tick();
    await until(()=>f.agents.schedules.get(fail.id)?.state==="interrupted","Failure not settled");
    const count=f.turns().length;
    f.settings({}); f.restart(); f.agents.limit=1; await f.tick(); await f.tick();
    assert.equal(f.turns().length,count);
    assert.equal(f.agents.workspace("task",fail.id).session.runState,"interrupted");
  } finally {f.close();}
});

test("cancellation before dispatch prevents startup; task cancellation also cancels its schedule", async () => {
  const f=fixture();
  try {
    const task=f.task("CANCEL"),saved=schedule(f,task.id); due(f,task.id);
    f.agents.cancelSchedule(task.id,saved.version); f.agents.limit=1; await f.tick(); assert.equal(f.turns().length,0);
    const other=f.task("CLOSED"); schedule(f,other.id);
    f.tasks.transition(other.id,{to:"closed",outcome:"cancelled"},"user");
    assert.equal(f.agents.schedules.get(other.id)?.state,"cancelled"); await f.tick(); assert.equal(f.turns().length,0);
  } finally {f.close();}
});

test("restart of a persisted reservation interrupts it and removes its automatic delivery", async () => {
  const f=fixture();
  try {
    const task=f.task("RSRV"),saved=schedule(f,task.id); due(f,task.id);
    assert.equal(f.agents.schedules.reserve(task.id,saved.version),true);
    const now=new Date().toISOString();
    f.database.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at) VALUES ('uncertain','task',?,'user','Intake',?,?)").run(task.id,JSON.stringify({scheduleVersion:saved.version}),now);
    f.database.db.prepare("INSERT INTO pending_messages(message_id,initial) VALUES ('uncertain',1)").run();
    f.restart(); f.agents.limit=1; await f.tick();
    assert.equal(f.agents.schedules.get(task.id)?.state,"interrupted"); assert.equal(f.turns().length,0);
    assert.equal(f.database.db.prepare("SELECT 1 FROM pending_messages WHERE message_id='uncertain'").get(),undefined);
    assert.equal(f.agents.workspace("task",task.id).messages.length,1);
  } finally {f.close();}
});

test("scheduled tasks wait for occupied worktrees, including different projects sharing a directory", async () => {
  const f=fixture();
  try {
    const first=f.task("FIRST"), second=f.task("OTHER");
    for (const task of [first,second]) {
      f.agents.workspace("task",task.id);
      f.database.db.prepare("UPDATE agent_sessions SET intake_state='ready' WHERE owner_id=?").run(task.id);
    }
    schedule(f,first.id); schedule(f,second.id); due(f,first.id,-2000); due(f,second.id,-1000); f.agents.limit=2;
    await f.tick(); await until(()=>f.agents.schedules.get(first.id)?.state==="started","First did not start");
    await f.tick(); assert.equal(f.agents.schedules.get(second.id)?.state,"pending"); assert.equal(f.turns().length,1);
    await f.complete("task",first.id); await f.tick();
    await until(()=>f.agents.schedules.get(second.id)?.state==="started","Worktree was not released");
    assert.equal(f.turns().length,2);
  } finally {f.close();}
});

test("schedule changes preserve creation files, comments and canvas data", () => {
  const f=fixture();
  try {
    const task=f.task("FILES");
    f.database.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at) VALUES ('creation','task',?,'user','Files',?,?)").run(task.id,JSON.stringify({taskCreation:true,attachments:[]}),new Date().toISOString());
    const document={format:"web",artboard:{width:300,height:300,background:"#fff",name:"Preserve"},html:"<main data-qahwa-id='m'>Keep</main>",css:""};
    f.database.db.prepare("INSERT INTO design_pages(id,task_id,name,document_json,revision,created_at,updated_at) VALUES ('page',?,'Preserve',?,1,?,?)").run(task.id,JSON.stringify(document),new Date().toISOString(),new Date().toISOString());
    const before=f.database.db.prepare("SELECT * FROM design_pages").all();
    const messages=f.database.db.prepare("SELECT * FROM chat_messages").all();
    const saved=schedule(f,task.id); f.agents.cancelSchedule(task.id,saved.version);
    assert.deepEqual(f.database.db.prepare("SELECT * FROM design_pages").all(),before);
    assert.deepEqual(f.database.db.prepare("SELECT * FROM chat_messages").all(),messages);
  } finally {f.close();}
});

test("schedule endpoints require authentication, reject stale writes and update workspace polling", async () => {
  const f=fixture(); const task=f.task("API");
  const app=await buildApp(f.config,f.database,{generateTitle:async()=>"Title"});
  const token=new AuthService(f.database,365).createSession("test","127.0.0.1","device").token;
  const headers={authorization:`Bearer ${token}`,origin:f.config.publicBaseUrl};
  try {
    const url=`/api/tasks/${task.humanId}/schedule`;
    const payload={expectedVersion:0,localTime:"2099-11-01T15:00",timezone:"UTC",policy:"when_available"};
    assert.equal((await app.inject({method:"PUT",url,payload})).statusCode,401);
    const before=f.agents.workspace("task",task.id), cursor=workspacePoll(before,{});
    const result=await app.inject({method:"PUT",url,payload,headers});
    assert.equal(result.statusCode,200); assert.equal(result.json().workspace.schedule.state,"pending");
    assert.notEqual(workspacePoll(f.agents.workspace("task",task.id),{}).revision,cursor.revision);
    assert.equal((await app.inject({method:"PUT",url,payload,headers})).statusCode,409);
    assert.equal((await app.inject({method:"POST",url:`${url}/cancel`,payload:{expectedVersion:1},headers})).statusCode,200);
    assert.equal(f.tasks.getTask(task.id).status,"todo");
  } finally {f.agents.close();f.attachments.close();await app.close();}
});

test("creation attachments survive schedule edits, removal, retention and scheduled intake", async () => {
  const f=fixture();
  try {
    const base=f.task("ATTACH");
    const creation=new TaskCreationService(f.database,f.tasks,f.attachments), draftId=randomUUID(), bytes=Buffer.from("Scheduled task requirements");
    const file=creation.initiate(draftId,"device",{filename:"requirements.txt",mediaType:"text/plain",size:bytes.length});
    f.attachments.appendChunk(file.id,"device",0,bytes); f.attachments.complete(file.id,"device");
    const task=creation.create({projectId:base.projectId,title:"Scheduled with files",status:"backlog",draftId,attachmentIds:[file.id]},"device");
    const saved=schedule(f,task.id); f.agents.cancelSchedule(task.id,saved.version);
    const resaved=f.agents.saveSchedule(task.id,{expectedVersion:saved.version+1,localTime:"2099-12-01T12:00",timezone:"UTC",policy:"when_available"}).schedule!;
    assert.equal(resaved.state,"pending");
    f.attachments.cleanupStale(Date.now()+365*86400000);
    assert.equal(readFileSync(f.attachments.resolveDownload("task",task.id,file.id).path).toString(),bytes.toString());
    due(f,task.id); f.agents.limit=1; await f.tick();
    await until(()=>f.agents.schedules.get(task.id)?.state==="started","Attached intake not started");
    assert.match(f.turns()[0]!.params.input[0].text,/requirements\.txt/);
    assert.equal(readFileSync(f.attachments.resolveDownload("task",task.id,file.id).path).toString(),bytes.toString());
  } finally {f.close();}
});

test("terminal and previously started tasks cannot be scheduled", async () => {
  const f=fixture();
  try {
    const terminal=f.task("TERM"); f.database.db.prepare("UPDATE tasks SET session_kind='terminal' WHERE id=?").run(terminal.id);
    assert.throws(()=>schedule(f,terminal.id),/unstarted Codex/);
    const started=f.task("BEGUN"); f.agents.limit=1; await f.agents.triggerTask(started.id);
    assert.throws(()=>schedule(f,started.id),/unstarted Codex/);
  } finally {f.close();}
});
