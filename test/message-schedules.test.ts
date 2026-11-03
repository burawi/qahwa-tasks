import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentService } from "../src/server/agent-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import { workspacePoll } from "../src/server/workspace-poll.js";
import { insertDesignPage, selectDesignPage } from "../src/server/design-pages.js";

const input = (message = "Check the result tomorrow", policy = "when_available") => ({
  expectedVersion: 0, message, localTime: "2099-10-31T14:30", timezone: "Africa/Tunis", policy,
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "qahwa-followups-"));
  const config = { host:"127.0.0.1",port:3022,publicBaseUrl:"http://localhost",dataDir:root,backupDir:join(root,"backups"),sessionDays:365 };
  let db = new AppDatabase(config), tasks = new TaskService(db), attachments = new AttachmentService(db);
  let agents: AgentService;
  let slots = 0, sequence = 0;
  let failure: string | null = null;
  let gate: Promise<void> | null = null;
  const requests: {method:string; params:any}[] = [];
  class FixtureAgents extends AgentService {
    override capacity() { return {activeTurns:0,availableSlots:slots,recommendedParallelism:slots} as any; }
  }
  const createAgents = () => {
    agents = new FixtureAgents(db, tasks, attachments);
    const codex = Reflect.get(agents, "codex");
    t.mock.method(codex, "initialize", async () => {});
    t.mock.method(codex, "request", async (method:string, params:any) => {
      requests.push({method,params});
      if (method === "turn/start" && gate) await gate;
      if (method === failure) throw new Error(`Uncertain ${method}`);
      return method === "thread/start" ? {thread:{id:`new-thread-${++sequence}`}} : method === "turn/start" ? {turn:{id:`turn-${++sequence}`}} : {};
    });
  };
  createAgents();
  const f = {
    root, config, requests,
    get db() { return db; }, get tasks() { return tasks; }, get agents() { return agents; },
    slots(n:number) { slots=n; }, failure(method:string|null) { failure=method; }, gate(value:Promise<void>|null) { gate=value; },
    task(name="Followup", directory=root) {
      const p = tasks.createProject({name:`${name}-${++sequence}`,prefix:`F${sequence}`,rootDirectory:directory},"user");
      const task = tasks.createTask({projectId:p.id,title:name,status:"todo"},"user");
      tasks.transition(task.id,{to:"in_progress"},"codex");
      agents.workspace("task",task.id);
      db.db.prepare("UPDATE agent_sessions SET thread_id=?,run_state='idle',intake_state='ready' WHERE owner_id=?").run(`saved-${task.id}`,task.id);
      return tasks.getTask(task.id);
    },
    save(taskId:string, body=input(), id=randomUUID()) { agents.saveFollowup(taskId,id,body); return agents.messageSchedules.get(id)!; },
    due(id:string, offset=-1) { db.db.prepare("UPDATE message_schedules SET run_at=? WHERE message_id=?").run(new Date(Date.now()+offset).toISOString(),id); agents.messageSchedules.due(); },
    async drain() { await Reflect.get(agents,"drainPendingMessages").call(agents); },
    async start(id:string) { return Reflect.get(agents,"startSavedMessage").call(agents,id); },
    release(...ids:string[]) { for(const id of ids) db.db.prepare("UPDATE pending_messages SET dispatch_order=1 WHERE message_id=?").run(id); },
    idle(taskId:string) { db.db.prepare("UPDATE agent_sessions SET run_state='idle',active_turn_id=NULL,starting_message_id=NULL WHERE owner_id=?").run(taskId); },
    queued(): any[] { return Reflect.get(agents,"queuedMessages").call(agents); },
    turns() { return requests.filter(r=>r.method==="turn/start"); },
    restart() { agents.close(); attachments.close(); db.close(); db=new AppDatabase(config); tasks=new TaskService(db); attachments=new AttachmentService(db); createAgents(); },
  };
  t.after(async()=>{agents.close();await new Promise(resolve=>setImmediate(resolve));attachments.close();db.close();rmSync(root,{recursive:true,force:true});});
  return f;
}

test("follow-ups persist in the existing history, stay out of dispatch before due and reject stale writes", async t=>{
  const f=fixture(t), task=f.task(), original=f.tasks.getTask(task.id), saved=f.save(task.humanId);
  const w=f.agents.workspace("task",task.id), message=w.messages[0];
  assert.equal(w.canScheduleFollowup,true); assert.equal(message.schedule?.state,"pending");
  assert.equal(message.canEdit,false); assert.equal(message.canCancel,false);
  assert.equal(message.pending,false); assert.equal(f.queued().length,0);
  f.slots(2); await f.drain(); assert.equal(f.requests.length,0);
  const snapshot=Reflect.get(f.agents,"orchestratorSnapshot").call(f.agents);
  assert.equal(snapshot[0].recentConversation.length,0,"Future text must not leak as an ordinary request");
  assert.throws(()=>f.agents.saveFollowup(task.id,saved.messageId,input()),/changed/);
  const edited=f.agents.saveFollowup(task.id,saved.messageId,{...input("Updated follow-up"),expectedVersion:1});
  assert.equal(edited.messages[0].body,"Updated follow-up");
  assert.equal(edited.messages[0].schedule?.version,2);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM chat_messages").get().n,1);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM chat_message_versions").get().n,2);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM message_schedule_history").get().n,2);
  assert.equal(f.tasks.getTask(task.id).status,original.status);
  assert.equal(f.agents.workspace("task",task.id).session.threadId,`saved-${task.id}`);
  assert.throws(()=>f.agents.cancelFollowup(task.id,saved.messageId,1),/changed/);
  f.agents.cancelFollowup(task.id,saved.messageId,2);
  assert.equal(f.agents.messageSchedules.get(saved.messageId)?.state,"cancelled");
  assert.ok(f.agents.workspace("task",task.id).messages[0].cancelledAt);
  assert.equal(f.tasks.getTask(task.id).status,"in_progress");
});

test("validates existing open Codex eligibility, ownership, content, zone, DST and future time", t=>{
  const f=fixture(t), task=f.task(), saved=f.save(task.id), other=f.task("Other");
  assert.throws(()=>f.agents.saveFollowup(other.id,saved.messageId,{...input(),expectedVersion:1}),/not in this chat/);
  assert.throws(()=>f.agents.cancelFollowup(other.id,saved.messageId,1),/not in this chat/);
  for(const body of [{...input(),message:" "},{...input(),message:"x".repeat(30_001)},{...input(),timezone:"Unknown/Zone"},{...input(),localTime:"2027-02-30T12:00"},{...input(),timezone:"America/New_York",localTime:"2027-03-14T02:30"},{...input(),timezone:"America/New_York",localTime:"2027-11-07T01:30"},{...input(),localTime:"2000-01-01T12:00"},{...input(),policy:"bad"}]) assert.throws(()=>f.save(task.id,body));
  f.agents.workspace("task",other.id);
  f.db.db.prepare("UPDATE agent_sessions SET thread_id=NULL WHERE owner_id=?").run(other.id);
  assert.throws(()=>f.save(other.id),/existing, open/);
  f.db.db.prepare("UPDATE tasks SET session_kind='terminal' WHERE id=?").run(task.id);
  assert.throws(()=>f.save(task.id),/existing, open/);
});

for(const offset of [-1,0,60_000,60_001]) test(`skip policy reservation boundary ${offset}ms`,t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id,input("Boundary","skip_if_missed")), at=Date.parse(s.runAt);
  f.agents.messageSchedules.due(at+offset);
  assert.equal(f.queued().length,0,"Future projection cannot enter the real queue early");
  const reserved=f.agents.messageSchedules.reserve(s.messageId,s.version,at+offset);
  assert.equal(reserved,offset>=0 && offset<=60_000);
  if(reserved) assert.equal(f.agents.messageSchedules.reserve(s.messageId,s.version,at+offset),false);
  if(offset>60_000) assert.equal(f.agents.messageSchedules.get(s.messageId)?.state,"skipped");
});

test("due follow-up resumes exactly the saved thread, permissions and captured canvas page",async t=>{
  const f=fixture(t), task=f.task();
  const doc={format:"web" as const,artboard:{width:200,height:100,name:"Original",background:"#fff"},html:'<div data-qahwa-id="one">Keep</div>',css:""};
  const page=insertDesignPage(f.db.db,task.id,"Original",doc); selectDesignPage(f.db.db,task.id,page);
  const saved=f.save(task.id), second=insertDesignPage(f.db.db,task.id,"Second",doc); selectDesignPage(f.db.db,task.id,second);
  f.due(saved.messageId); f.release(saved.messageId); f.slots(2);
  await Promise.all([f.drain(),f.drain(),f.start(saved.messageId)]);
  assert.equal(f.turns().length,1); assert.equal(f.turns()[0].params.threadId,`saved-${task.id}`);
  assert.equal(f.requests.some(r=>r.method==="thread/start" || r.method==="thread/archive" || r.method==="turn/interrupt"),false);
  const resume=f.requests.find(r=>r.method==="thread/resume")!;
  assert.equal(resume.params.sandbox,"danger-full-access"); assert.equal(resume.params.approvalPolicy,"never");
  assert.equal(f.agents.messageSchedules.get(saved.messageId)?.state,"delivered");
  assert.equal(f.db.db.prepare("SELECT page_id FROM design_page_turns").get().page_id,page);
  f.idle(task.id); await f.drain(); assert.equal(f.turns().length,1);
  assert.equal(f.agents.workspace("task",task.id).messages.length,1);
});

test("follow-up in intake preserves read-only execution and never performs an implementation handoff",async t=>{
  const f=fixture(t), task=f.task();
  f.db.db.prepare("UPDATE agent_sessions SET intake_state='pending' WHERE owner_id=?").run(task.id);
  const s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(1);await f.drain();
  assert.equal(f.requests.find(r=>r.method==="thread/resume")?.params.sandbox,"read-only");
  assert.equal(f.turns()[0].params.threadId,`saved-${task.id}`);
});

test("ready intake follow-up also stays in its conversation, without consuming implementation handoff",async t=>{
  const f=fixture(t), task=f.task();
  f.db.db.prepare("UPDATE agent_sessions SET intake_state='ready' WHERE owner_id=?").run(task.id);
  f.db.db.prepare("INSERT INTO scheduler_queue(task_id,requested_by,reason,created_at) VALUES (?,'intake','Ready',?)").run(task.id,new Date().toISOString());
  const s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(1);await f.drain();
  assert.equal(f.requests.some(r=>r.method==="thread/archive" || r.method==="thread/start"),false);
  assert.ok(f.db.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id=?").get(task.id));
});

for(const state of ["running","waiting"]) test(`waits for ${state} turn, capacity and orchestrator control messages`,async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(2);
  f.db.db.prepare("UPDATE agent_sessions SET run_state=?,active_turn_id='existing-turn' WHERE owner_id=?").run(state,task.id);
  await f.drain();assert.equal(f.turns().length,0);
  f.idle(task.id);f.slots(0);await f.drain();assert.equal(f.turns().length,0);
  f.agents.workspace("orchestrator","main");f.db.db.prepare("UPDATE agent_sessions SET run_state='running' WHERE owner_type='orchestrator'").run();
  f.slots(2);await f.drain();assert.equal(f.turns().length,0);
  f.db.db.prepare("UPDATE agent_sessions SET run_state='idle' WHERE owner_type='orchestrator'").run();
  await f.drain();assert.equal(f.turns().length,1);
  assert.equal(f.requests.some(r=>r.method==="turn/interrupt" || r.method==="turn/steer"),false);
});

test("respects canonical shared and nested worktrees across separate projects",async t=>{
  const f=fixture(t);const directory=join(f.root,"repo");mkdirSync(directory);const alias=join(f.root,"alias");symlinkSync(directory,alias);
  const task=f.task("One",alias), other=f.task("Other",directory), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(3);
  f.db.db.prepare("UPDATE agent_sessions SET run_state='running' WHERE owner_id=?").run(other.id);
  await f.drain();assert.equal(f.turns().length,0);
  f.idle(other.id);await f.drain();assert.equal(f.turns().length,1);
});

test("future follow-ups do not block immediate messages; due ones respect existing FIFO and stale dispatch",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);
  const pending=(await f.agents.send("task",task.id,"Earlier immediate message")).messages.at(-1)!;
  assert.equal(f.queued()[0].id,pending.id);
  f.due(s.messageId);f.release(s.messageId,pending.id);f.slots(2);
  assert.equal(await f.start(s.messageId),false,"Cannot jump over an earlier saved message");
  await f.drain();assert.match(f.turns()[0].params.input[0].text,/Earlier immediate message/);
  f.idle(task.id);await f.drain();assert.match(f.turns()[1].params.input[0].text,/Check the result tomorrow/);
});

test("editing an overdue pending body works; moving its time revokes queued dispatch",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);
  assert.throws(()=>f.agents.editPendingMessage("task",task.id,s.messageId,{message:"Bypass",expectedVersion:1}),/Edit scheduled/);
  f.agents.saveFollowup(task.id,s.messageId,{...input("Overdue edited"),expectedVersion:1});
  assert.equal(f.queued()[0].id,s.messageId);
  f.agents.saveFollowup(task.id,s.messageId,{...input("Moved"),expectedVersion:2,localTime:"2099-11-01T15:00"});
  assert.equal(f.queued().length,0);f.slots(2);assert.equal(await f.start(s.messageId),false);
  f.due(s.messageId);f.release(s.messageId);await f.drain();assert.match(f.turns()[0].params.input[0].text,/Moved/);
});

test("cancel and close win before reservation; restore never revives pending schedules",async t=>{
  const f=fixture(t), task=f.task(), one=f.save(task.id), two=f.save(task.id);f.due(one.messageId);f.release(one.messageId);
  f.agents.cancelFollowup(task.id,one.messageId,1);f.slots(2);assert.equal(await f.start(one.messageId),false);
  f.tasks.transition(task.id,{to:"closed",outcome:"cancelled"},"user");
  assert.equal(f.agents.messageSchedules.get(two.messageId)?.state,"cancelled");
  assert.throws(()=>f.save(task.id),/existing, open/);
  f.tasks.restoreCodex(task.id,f.tasks.getTask(task.id).version);
  f.agents.messageSchedules.due(Date.parse(two.runAt)+1000);await f.drain();assert.equal(f.turns().length,0);
  assert.equal(f.agents.workspace("task",task.id).messages.length,2);
});

test("completed closure cancels follow-ups too and preserves canvas, comments and history",t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);
  const original=f.db.db.prepare("SELECT * FROM chat_messages WHERE id=?").get(s.messageId);
  f.tasks.transition(task.id,{to:"in_review"},"codex");f.tasks.transition(task.id,{to:"closed",outcome:"completed"},"user");
  assert.equal(f.agents.messageSchedules.get(s.messageId)?.state,"cancelled");
  assert.equal(f.db.db.prepare("SELECT body FROM chat_messages WHERE id=?").get(s.messageId).body,original.body);
});

test("reservation blocks stale edit/remove; concurrent drains cannot duplicate delivery",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(2);
  let release!:()=>void;f.gate(new Promise<void>(r=>release=r));
  const drain=f.drain();
  assert.equal(f.agents.messageSchedules.get(s.messageId)?.state,"reserved");
  assert.throws(()=>f.agents.saveFollowup(task.id,s.messageId,{...input(),expectedVersion:1}),/changed/);
  assert.throws(()=>f.agents.cancelFollowup(task.id,s.messageId,2),/reserved/);
  await f.drain();assert.equal(await f.start(s.messageId),false);
  release();await drain;assert.equal(f.turns().length,1);
});

for(const method of ["thread/resume","turn/start"]) test(`uncertain ${method} is never retried and never creates a replacement conversation`,async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(2);f.failure(method);
  await f.drain();assert.equal(f.agents.messageSchedules.get(s.messageId)?.state,"interrupted");
  f.failure(null);f.idle(task.id);await f.drain();f.restart();await f.drain();
  assert.equal(f.requests.filter(r=>r.method===method).length,1);
  assert.equal(f.requests.some(r=>r.method==="thread/start"),false);
  assert.equal(f.agents.workspace("task",task.id).session.threadId,`saved-${task.id}`);
});

test("restart retains pending absolute times, skips expired windows and suppresses reserved deliveries",async t=>{
  const f=fixture(t), task=f.task(), future=f.save(task.id), waiting=f.save(task.id), missed=f.save(task.id,input("Missed","skip_if_missed")), uncertain=f.save(task.id);
  f.due(waiting.messageId,-120_000);f.due(missed.messageId,-60_001);f.due(uncertain.messageId);
  f.agents.messageSchedules.reserve(uncertain.messageId,1);
  f.restart();
  assert.equal(f.agents.messageSchedules.get(future.messageId)?.runAt,future.runAt);
  assert.equal(f.agents.messageSchedules.get(uncertain.messageId)?.state,"interrupted");
  assert.equal(f.agents.messageSchedules.get(missed.messageId)?.state,"skipped");
  assert.equal(f.agents.messageSchedules.get(waiting.messageId)?.state,"pending");
  await new Promise(resolve=>setImmediate(resolve));f.release(waiting.messageId);f.slots(2);await f.drain();assert.equal(f.turns().length,1);
  assert.equal(f.agents.messageSchedules.get(waiting.messageId)?.state,"delivered");
  f.restart();await f.drain();assert.equal(f.turns().length,1);
});

test("authenticated schedule routes guard stale writes, wrong chats and polling revisions",async t=>{
  const f=fixture(t), task=f.task();f.agents.close();
  const app=await buildApp(f.config,f.db,{generateTitle:async()=>"Title"});
  t.after(()=>app.close());
  const now=new Date().toISOString();
  f.db.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(now,now);
  const auth=new AuthService(f.db,365), token=auth.createSession("test","127.0.0.1","device").token;
  const headers={authorization:`Bearer ${token}`,origin:f.config.publicBaseUrl}, id=randomUUID(), url=`/api/tasks/${task.humanId}/messages/${id}/schedule`;
  const before=workspacePoll(f.agents.workspace("task",task.id),{});
  assert.equal((await app.inject({method:"PUT",url,payload:input()})).statusCode,401);
  const saved=await app.inject({method:"PUT",url,payload:input(),headers});
  assert.equal(saved.statusCode,200);assert.equal(saved.json().workspace.messages[0].schedule.state,"pending");
  assert.notEqual(workspacePoll(saved.json().workspace,{}).revision,before.revision);
  assert.equal((await app.inject({method:"PUT",url,payload:input(),headers})).statusCode,409);
  assert.equal((await app.inject({method:"POST",url:`${url}/cancel`,payload:{expectedVersion:0},headers})).statusCode,409);
  assert.equal((await app.inject({method:"POST",url:`${url}/cancel`,payload:{expectedVersion:1},headers})).statusCode,200);
  await app.close();
});

test("a second database connection cannot reserve after edit, removal or closure",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);
  const second=new AppDatabase(f.config), tasks=new TaskService(second);
  const {MessageSchedules}=await import("../src/server/message-schedules.js");const schedules=new MessageSchedules(second,tasks);
  try {
    schedules.save(task.id,s.messageId,{...input("Other device edit"),expectedVersion:1});
    assert.equal(f.agents.messageSchedules.reserve(s.messageId,1),false);
    schedules.cancel(task.id,s.messageId,2);assert.equal(f.agents.messageSchedules.reserve(s.messageId,2),false);
    const next=f.save(task.id);f.due(next.messageId);
    tasks.transition(task.id,{to:"closed",outcome:"cancelled"},"user");
    assert.equal(f.agents.messageSchedules.reserve(next.messageId,1),false);
    tasks.restoreCodex(task.id,tasks.getTask(task.id).version);
    f.slots(1);assert.equal(await f.start(next.messageId),false);
  } finally { second.close(); }
});

test("failed persistence rolls back message, time edits and cancellation together",t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);
  const before=f.agents.workspace("task",task.id), queue=f.queued();
  f.db.db.exec("CREATE TRIGGER fail_followup_history BEFORE INSERT ON message_schedule_history BEGIN SELECT RAISE(ABORT,'History storage failed'); END");
  assert.throws(()=>f.agents.saveFollowup(task.id,s.messageId,{...input("Must roll back"),expectedVersion:1,localTime:"2099-12-01T15:00"}),/History storage/);
  assert.deepEqual(f.agents.workspace("task",task.id),before);assert.deepEqual(f.queued(),queue);
  assert.throws(()=>f.agents.cancelFollowup(task.id,s.messageId,1),/History storage/);
  assert.deepEqual(f.agents.workspace("task",task.id),before);assert.deepEqual(f.queued(),queue);
});

test("ordinary queue planning releases a due follow-up without bypassing the control turn",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.slots(2);
  await f.drain();assert.equal(f.turns().length,1);assert.notEqual(f.turns()[0].params.threadId,`saved-${task.id}`);
  const pending=Reflect.get(f.agents,"pendingTaskMessages").call(f.agents);
  assert.equal(pending[0].messageId,s.messageId);
  await Reflect.get(f.agents,"applyOrchestratorActions").call(f.agents,[{type:"dispatch",messageIds:[s.messageId]}]);
  assert.equal(f.turns().length,1);
  f.db.db.prepare("UPDATE agent_sessions SET run_state='idle',active_turn_id=NULL WHERE owner_type='orchestrator'").run();
  await f.drain();assert.equal(f.turns().length,2);assert.equal(f.turns()[1].params.threadId,`saved-${task.id}`);
});

test("a reserved delivery requires pause before closure and cannot replay after restore",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(2);
  let release!:()=>void;f.gate(new Promise<void>(r=>release=r));const drain=f.drain();
  assert.throws(()=>f.tasks.transition(task.id,{to:"closed",outcome:"cancelled"},"user"),{code:"task_running"});
  release();await drain;
  assert.throws(()=>f.tasks.transition(task.id,{to:"closed",outcome:"cancelled"},"user"),{code:"task_running"});
  await f.agents.interrupt("task",task.id);
  f.tasks.transition(task.id,{to:"closed",outcome:"cancelled"},"user");
  assert.equal(f.tasks.getTask(task.id).status,"closed");assert.equal(f.turns().length,1);
  f.idle(task.id);f.tasks.restoreCodex(task.id,f.tasks.getTask(task.id).version);
  await f.drain();assert.equal(f.turns().length,1);
});

test("schedule edits, delivery, cancellation and restart preserve prior attachments, canvas and comments",async t=>{
  const f=fixture(t), task=f.task();
  const {documentFromPlainText}=await import("../src/domain/types.js");
  const {readFileSync}=await import("node:fs");
  const timestamp=new Date().toISOString();
  f.db.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(timestamp,timestamp);
  const attachments=Reflect.get(f.agents,"attachments") as AttachmentService;
  const upload=attachments.initiate("task",task.id,"device",{filename:"context.txt",mediaType:"text/plain",size:7});
  attachments.appendChunk(upload.id,"device",0,Buffer.from("context"));attachments.complete(upload.id,"device");
  f.db.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at) VALUES ('old-history','task',?,'user','Prior context',?,?)")
    .run(task.id,JSON.stringify({attachments:[{id:upload.id,filename:"context.txt",mediaType:"text/plain",size:7}],custom:"keep"}),timestamp);
  attachments.attachToMessage([upload.id],"old-history");
  const doc={format:"web" as const,artboard:{width:390,height:844,name:"Preserved",background:"#fff"},html:'<h1 data-qahwa-id="heading">Keep</h1>',css:""};
  const page=insertDesignPage(f.db.db,task.id,"Preserved",doc);selectDesignPage(f.db.db,task.id,page);
  f.tasks.addComment(task.id,{body:documentFromPlainText("Keep canvas feedback"),metadata:{canvas:{pageId:page,elementId:"heading"}}},"user");
  const before=f.agents.workspace("task",task.id), comments=f.tasks.getTask(task.id).comments;
  const a=f.save(task.id), b=f.save(task.id);
  f.agents.saveFollowup(task.id,a.messageId,{...input("Revised"),expectedVersion:1});f.agents.cancelFollowup(task.id,a.messageId,2);
  f.due(b.messageId);f.release(b.messageId);f.slots(2);await f.drain();f.restart();
  const after=f.agents.workspace("task",task.id);
  assert.deepEqual(after.messages.find(m=>m.id==="old-history"),before.messages[0]);
  assert.deepEqual(after.designPages,before.designPages);assert.equal(after.selectedDesignPageId,page);
  assert.deepEqual(f.tasks.getTask(task.id).comments,comments);
  const files=Reflect.get(f.agents,"attachments") as AttachmentService;
  assert.equal(readFileSync(files.resolveDownload("task",task.id,upload.id).path,"utf8"),"context");
  assert.deepEqual(f.db.db.pragma("foreign_key_check"),[]);
});

test("periodic scheduling waits until due and then dispatches without a manual drain",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);
  f.db.db.prepare("UPDATE message_schedules SET run_at=? WHERE message_id=?").run(new Date(Date.now()+50).toISOString(),s.messageId);
  assert.equal(f.queued().length,0);
  const until=async(condition:()=>boolean)=>{const deadline=Date.now()+4000;while(!condition()){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}};
  await until(()=>f.queued().some(m=>m.id===s.messageId));
  assert.equal(f.turns().length,0);f.release(s.messageId);f.slots(2);
  await until(()=>f.agents.messageSchedules.get(s.messageId)?.state==="delivered");
  assert.equal(f.turns().length,1);assert.equal(f.turns()[0].params.threadId,`saved-${task.id}`);
});

test("restart during the actual RPC reservation clears startup ownership without replay",async t=>{
  const f=fixture(t), task=f.task(), s=f.save(task.id);f.due(s.messageId);f.release(s.messageId);f.slots(2);
  let release!:()=>void;f.gate(new Promise<void>(r=>release=r));const pending=f.drain();
  while(!f.turns().length) await new Promise(r=>setImmediate(r));
  f.slots(0);f.restart();
  assert.equal(f.agents.messageSchedules.get(s.messageId)?.state,"interrupted");
  assert.equal(f.agents.workspace("task",task.id).session.runState,"interrupted");
  assert.equal(f.db.db.prepare("SELECT starting_message_id FROM agent_sessions WHERE owner_id=?").get(task.id).starting_message_id,null);
  assert.equal(f.queued().length,0);release();await pending;
  f.slots(2);await f.drain();assert.equal(f.turns().length,1);
});
