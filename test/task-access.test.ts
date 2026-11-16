import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { AgentService, parseAgentEnvelope } from "../src/server/agent-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { TerminalService } from "../src/server/terminal-service.js";
import { rootsOverlap } from "../src/server/task-access.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";

function fixture(t: TestContext) {
  // Constructor supervision is a separate integration path; drive these queues explicitly.
  t.mock.method(AgentService.prototype as any,"monitorPortfolio",async()=>{});
  const root = mkdtempSync(join(tmpdir(), "qahwa-task-access-"));
  const worktree = join(root, "wassala"); mkdirSync(worktree);
  writeFileSync(join(worktree, "source.txt"), "Sousse implementation must remain untouched\n");
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: join(root,"data"), backupDir: join(root,"backups"), sessionDays: 365 };
  let db = new AppDatabase(config), tasks = new TaskService(db), attachments = new AttachmentService(db, join(root,"files"));
  let agents = new AgentService(db,tasks,attachments);
  let slots = 4, serial = 0, gate: Promise<void> | undefined;
  const calls: Array<{ method: string; params: any }> = [], responses: any[] = [];
  const configure = () => {
    t.mock.method(agents,"capacity",() => ({ activeTurns: 0, availableSlots: slots } as any));
    const codex = Reflect.get(agents,"codex");
    t.mock.method(codex,"initialize",async () => { await gate; });
    t.mock.method(codex,"request",async (method: string, params: any) => {
      calls.push({method,params});
      if (method === "thread/start") return {thread:{id:`thread-${++serial}`}};
      if (method === "turn/start") return {turn:{id:`turn-${++serial}`}};
      return {};
    });
    t.mock.method(codex,"respond",(id: unknown,result: unknown) => responses.push({id,result}));
  };
  configure();
  const project = tasks.createProject({name:"Wassala fixture",prefix:"WAS",rootDirectory:worktree},"user");
  const f = {
    root,worktree,config,project,calls,responses,
    get db(){return db;},get tasks(){return tasks;},get agents(){return agents;}, get attachments(){return attachments;},
    task(title = "Operator canvas preparation", projectId = project.id) {
      const task=tasks.createTask({projectId,title,status:"in_progress"},"user");
      agents.workspace("task",task.id);
      db.db.prepare("UPDATE agent_sessions SET intake_state='ready' WHERE owner_id=?").run(task.id);
      return task;
    },
    mode(id: string, mode: "read-only" | "worktree-write") {
      return agents.requestTaskAccess(id,{mode,expectedVersion:agents.workspace("task",id).session.accessVersion});
    },
    active(id: string, mode: "read-only" | "worktree-write" = "worktree-write", state = "running") {
      db.db.prepare("UPDATE agent_sessions SET run_state=?,active_access_mode=?,thread_id=?,active_turn_id=? WHERE owner_id=?")
        .run(state,mode,`saved-${id}`,`active-${id}`,id);
    },
    idle(id: string) { db.db.prepare("UPDATE agent_sessions SET run_state='idle',active_turn_id=NULL,starting_message_id=NULL WHERE owner_id=?").run(id); },
    slots(value: number){slots=value;}, gate(value?: Promise<void>){gate=value;},
    start(id: string){return Reflect.get(agents,"startSavedMessage").call(agents,id) as Promise<boolean>;},
    drain(){return Reflect.get(agents,"resumeQueues").call(agents) as Promise<void>;},
    async save(id: string, text: string) {
      const previous=slots;slots=0;
      const message=(await agents.send("task",id,text)).messages.at(-1)!;
      slots=previous;
      db.db.prepare("UPDATE pending_messages SET dispatch_order=1 WHERE message_id=?").run(message.id);
      return message;
    },
    finish(id: string, text: string) {
      const session=agents.workspace("task",id).session;
      Reflect.get(agents,"finishAgentMessage").call(agents,{ownerType:"task",ownerId:id},`answer-${++serial}`,text,session.activeTurnId);
    },
    restart() {
      agents.close();attachments.close();db.close();
      db=new AppDatabase(config);tasks=new TaskService(db);attachments=new AttachmentService(db,join(root,"files"));
      agents=new AgentService(db,tasks,attachments);configure();
    },
  };
  t.after(() => {agents.close();attachments.close();if(db.db.open)db.close();rmSync(root,{recursive:true,force:true});});
  return f;
}

test("Operator preparation starts beside Sousse editing and saves canvas without changing its worktree or session",async t => {
  const f=fixture(t), sousse=f.task("Sousse menu implementation"), operator=f.task();
  f.active(sousse.id);f.mode(operator.id,"read-only");
  const before=f.db.db.prepare("SELECT * FROM agent_sessions WHERE owner_id=?").get(sousse.id);
  await f.agents.triggerTask(operator.id);
  assert.equal(f.agents.workspace("task",operator.id).session.runState,"running");
  assert.equal(f.calls.find(c=>c.method==="thread/start")?.params.sandbox,"read-only");
  assert.match(f.calls.find(c=>c.method==="thread/start")?.params.developerInstructions,/Effective task access: read-only/);
  assert.deepEqual(f.calls.find(c=>c.method==="turn/start")?.params.sandboxPolicy,{type:"readOnly"});
  f.finish(operator.id,`Prepared. <qahwa-design>${JSON.stringify({format:"web",artboard:{width:390,height:844,background:"#fff",name:"Operator"},html:'<main data-qahwa-id="operator">Operations</main>',css:"main{padding:20px}"})}</qahwa-design>`);
  assert.equal(f.agents.workspace("task",operator.id).designPages.length,1);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM agent_sessions WHERE owner_id=?").get(sousse.id),before);
  assert.equal(readFileSync(join(f.worktree,"source.txt"),"utf8"),"Sousse implementation must remain untouched\n");
  assert.equal(f.calls.some(c=>c.method==="turn/interrupt"),false);
});

test("all start paths block a second editor and permit a reader, including waiting writers and overlapping projects",async t => {
  const f=fixture(t), editor=f.task("Sousse menu"), next=f.task("Unclassified implementation");
  f.active(editor.id,"worktree-write","waiting");
  await assert.rejects(f.agents.triggerTask(next.id),{code:"project_conflict"});
  const m=await f.save(next.id,"Edit shared files");
  assert.equal(await f.start(m.id),false);
  await assert.rejects(f.agents.runPendingMessageNow("task",next.id,m.id),{code:"project_conflict"});
  assert.match(f.agents.workspace("task",next.id).session.accessReason!,/exclusive editing access/);
  f.mode(next.id,"read-only");assert.equal(await f.start(m.id),true);
  f.idle(next.id);f.mode(next.id,"worktree-write");
  const nested=join(f.worktree,"apps");mkdirSync(nested);
  const project=f.tasks.createProject({name:"Nested",prefix:"SUB",rootDirectory:nested},"user");
  const child=f.task("Child editor",project.id);
  await assert.rejects(f.agents.triggerTask(child.id),{code:"project_conflict"});
  f.mode(child.id,"read-only");await f.agents.triggerTask(child.id);
  assert.equal(f.agents.workspace("task",child.id).session.activeAccessMode,"read-only");
});

test("two readers and an editor can coexist; read-only work still obeys capacity",async t => {
  const f=fixture(t), reader=f.task(), another=f.task("Research"), editor=f.task("Edit");
  f.mode(reader.id,"read-only");f.mode(another.id,"read-only");
  f.active(reader.id,"read-only");await f.agents.triggerTask(editor.id);await f.agents.triggerTask(another.id);
  f.idle(another.id);f.slots(0);
  await assert.rejects(f.agents.triggerTask(another.id),{code:"capacity_full"});
  const m=await f.save(another.id,"Read only");assert.equal(await f.start(m.id),false);
  await assert.rejects(f.agents.runPendingMessageNow("task",another.id,m.id),{code:"capacity_full"});
  f.slots(1);assert.equal(await f.start(m.id),true);
});

test("editing transition keeps active read grant, queues authorized continuation, and waits without losing FIFO",async t => {
  const f=fixture(t), editor=f.task("Sousse menu"), reader=f.task();
  f.active(editor.id);f.mode(reader.id,"read-only");
  await f.agents.send("task",reader.id,"Now implement the operator page in source files");
  const older=await f.save(reader.id,"Keep this earlier follow-up in order");
  f.finish(reader.id,'Waiting. <!-- qahwa-access:{"mode":"worktree-write","authorization":"implement the operator page in source files"} -->');
  let w=f.agents.workspace("task",reader.id);
  assert.equal(w.session.accessMode,"worktree-write");assert.equal(w.session.activeAccessMode,"read-only");
  assert.match(w.session.accessReason!,/exclusive/);
  const continuation=w.messages.find(m=>m.metadata?.accessTransition)!;
  assert.ok(continuation.pending);assert.ok(w.messages.findIndex(m=>m.id===older.id)<w.messages.findIndex(m=>m.id===continuation.id));
  f.idle(reader.id);await f.drain();assert.ok(f.agents.workspace("task",reader.id).messages.at(-1)?.pending);
  f.idle(editor.id);await f.drain();
  assert.equal(f.agents.workspace("task",reader.id).messages.find(m=>m.id===older.id)?.pending,false);
  assert.equal(f.agents.workspace("task",reader.id).messages.find(m=>m.id===continuation.id)?.pending,true);
  assert.equal(f.calls.filter(c=>c.method==="thread/resume").at(-1)?.params.sandbox,"danger-full-access");
  f.idle(reader.id);await f.drain();assert.equal(f.agents.workspace("task",reader.id).messages.find(m=>m.id===continuation.id)?.pending,false);
});

test("unmatched or undelivered authorization cannot change read-only access; permission requests fail closed",async t => {
  const f=fixture(t), reader=f.task();f.mode(reader.id,"read-only");await f.agents.triggerTask(reader.id);
  await f.save(reader.id,"Please edit the files");
  f.finish(reader.id,'<!-- qahwa-access:{"mode":"worktree-write","authorization":"Please edit the files"} -->');
  assert.equal(f.agents.workspace("task",reader.id).session.accessMode,"read-only");
  for (const method of ["item/permissions/requestApproval","item/commandExecution/requestApproval","item/fileChange/requestApproval"]) {
    Reflect.get(f.agents,"storePending").call(f.agents,{ownerType:"task",ownerId:reader.id},42,method,{permissions:{fileSystem:{write:[f.worktree]}}});
  }
  assert.equal(f.responses.length,3);assert.deepEqual(f.responses[0].result.permissions,{});
  assert.equal(f.agents.workspace("task",reader.id).pendingRequests.length,0);
  const now=new Date().toISOString();
  f.db.db.prepare("INSERT INTO pending_requests(id,owner_type,owner_id,rpc_request_id,request_type,payload_json,created_at) VALUES ('old','task',?,'42','permissions','{}',?)").run(reader.id,now);
  await assert.rejects(f.agents.resolveRequest("old",{approved:true}),{code:"read_only_access"});
});

test("startup grants are atomic: racing editors cannot overlap or turn a read grant into write access",async t => {
  const f=fixture(t), first=f.task("Editor A"), second=f.task("Editor B");
  const a=await f.save(first.id,"Edit A"), b=await f.save(second.id,"Edit B");
  let release!:()=>void;f.gate(new Promise<void>(r=>{release=r;}));
  const starting=f.start(a.id);assert.equal(f.agents.workspace("task",first.id).session.runState,"running");
  assert.equal(await f.start(b.id),false);f.mode(first.id,"read-only");
  assert.equal(await f.start(b.id),false);release();await starting;
  assert.equal(f.calls.find(c=>c.method==="thread/start")?.params.sandbox,"danger-full-access");
  f.idle(first.id);f.mode(first.id,"read-only");
  const read=await f.save(first.id,"Read A");f.gate(new Promise<void>(r=>{release=r;}));
  const reading=f.start(read.id);f.mode(first.id,"worktree-write");
  const editing=f.start(b.id);release();await Promise.all([reading,editing]);
  assert.equal(f.calls.filter(c=>c.method==="thread/resume").at(-1)?.params.sandbox,"read-only");
  assert.equal(f.agents.workspace("task",first.id).session.activeAccessMode,"read-only");
});

test("read mode, pending editing intent, saved threads, and message order survive restart and task restoration",async t => {
  const f=fixture(t), editor=f.task("Sousse menu"), reader=f.task();f.active(editor.id);f.mode(reader.id,"read-only");
  await f.agents.send("task",reader.id,"Implement this page in source");
  f.finish(reader.id,'<!-- qahwa-access:{"mode":"worktree-write","authorization":"Implement this page in source"} -->');
  const before=f.agents.workspace("task",reader.id), queued=f.db.db.prepare("SELECT * FROM pending_messages").all();
  f.restart();
  const after=f.agents.workspace("task",reader.id);
  assert.equal(after.session.accessMode,"worktree-write");assert.equal(after.session.threadId,before.session.threadId);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM pending_messages").all(),queued);
  assert.deepEqual(after.messages,before.messages);
  f.active(editor.id);await f.drain();assert.equal(f.calls.filter(c=>c.method==="thread/resume").length,0);
  f.idle(editor.id);await f.drain();assert.equal(f.calls.filter(c=>c.method==="thread/resume").at(-1)?.params.sandbox,"danger-full-access");
  f.idle(reader.id);f.mode(reader.id,"read-only");f.tasks.transition(reader.id,{to:"closed",outcome:"cancelled"},"user");
  f.tasks.restoreCodex(reader.id,f.tasks.getTask(reader.id).version);
  await f.agents.send("task",reader.id,"Continue preparing canvas only");
  assert.equal(f.calls.filter(c=>c.method==="thread/resume").at(-1)?.params.sandbox,"read-only");
});

test("intake classifies from explicit scope; a queued read-only handoff survives restart and starts beside editing",async t => {
  const f=fixture(t), editor=f.task("Sousse"), reader=f.task("Ambiguous title");
  f.db.db.prepare("UPDATE agent_sessions SET intake_state='pending' WHERE owner_id=?").run(reader.id);
  f.active(editor.id);await f.agents.triggerTask(reader.id);
  f.finish(reader.id,'Canvas only; no project file edits. <!-- qahwa-intake:{"ready":true,"accessMode":"read-only"} -->');
  f.idle(reader.id);f.slots(0);
  const queue=f.db.db.prepare("SELECT * FROM scheduler_queue WHERE task_id=?").get(reader.id);
  assert.ok(queue);f.restart();f.active(editor.id);f.slots(1);await f.drain();
  assert.equal(f.agents.workspace("task",reader.id).session.activeAccessMode,"read-only");
  assert.equal(f.agents.workspace("task",reader.id).session.runState,"running");
  assert.equal(f.calls.filter(c=>c.method==="thread/start").at(-1)?.params.sandbox,"read-only");
  assert.equal(f.db.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id=?").get(reader.id),undefined);
});

test("orchestrator starts and access actions retain authorization and explicit mode",async t => {
  const f=fixture(t), editor=f.task("Sousse"), reader=f.task();f.active(editor.id);
  const apply=(actions: unknown[],quote?: string)=>Reflect.get(f.agents,"applyOrchestratorActions").call(f.agents,actions,quote);
  await apply([{type:"start",taskId:reader.id,accessMode:"read-only",authorization:"Prepare canvas without editing files"}],"Prepare canvas without editing files");
  assert.equal(f.agents.workspace("task",reader.id).session.activeAccessMode,"read-only");
  await apply([{type:"access",taskId:reader.id,accessMode:"worktree-write",authorization:"Not authorized"}],"Just inspect");
  assert.equal(f.agents.workspace("task",reader.id).session.accessMode,"read-only");
  f.db.setSetting("orchestrator_standing_directive",JSON.stringify({id:"continue",instruction:"Continue prioritized work",sourceQuote:"Continue prioritized work",createdAt:new Date().toISOString()}));
  for(const type of ["access","start"]) {
    await apply([{type,taskId:reader.id,accessMode:"worktree-write",authorization:"Continue prioritized work",directiveId:"continue"}]);
    assert.equal(f.agents.workspace("task",reader.id).session.accessMode,"read-only");
  }
  await apply([{type:"access",taskId:reader.id,accessMode:"worktree-write",authorization:"Implement in source"}],"Implement in source");
  assert.equal(f.agents.workspace("task",reader.id).session.accessMode,"worktree-write");
  assert.ok(f.agents.workspace("task",reader.id).hasPendingMessages);
  assert.equal(parseAgentEnvelope('<!-- qahwa-intake:{"ready":true} -->').intakeAccessMode,undefined);
});

test("root overlap handles parent, symlink, trailing slash, missing child and sibling boundaries",t=>{
  const f=fixture(t);symlinkSync(f.worktree,join(f.root,"alias"));
  for(const path of [f.worktree+"/",join(f.root,"alias"),join(f.worktree,"missing","child"),f.root,"/"]) assert.ok(rootsOverlap(f.worktree,path));
  assert.equal(rootsOverlap(f.worktree,f.worktree+"-other"),false);
});

test("scheduled starts and scheduled followups use the same reading and editing rules",async t=>{
  const f=fixture(t),editor=f.task("Sousse menu"),reader=f.task(),writer=f.task("Read-only in title is insufficient");f.active(editor.id);
  f.mode(reader.id,"read-only");
  // Task schedules start mandatory read-only intake, then their classified handoff.
  const fresh=f.tasks.createTask({projectId:f.project.id,title:"Scheduled preparation",status:"todo"},"user");
  const start=f.agents.saveSchedule(fresh.id,{expectedVersion:0,localTime:"2099-11-01T12:00",timezone:"UTC",policy:"when_available"}).schedule!;
  f.db.db.prepare("UPDATE task_schedules SET run_at=? WHERE task_id=?").run(new Date(Date.now()-1000).toISOString(),fresh.id);
  await f.drain();assert.equal(f.agents.schedules.get(fresh.id)?.state,"started");
  assert.equal(f.agents.workspace("task",fresh.id).session.activeAccessMode,"read-only");
  assert.ok(start.version);
  f.db.db.prepare("UPDATE agent_sessions SET thread_id=? WHERE owner_id=?").run("saved-reader",reader.id);
  f.db.db.prepare("UPDATE agent_sessions SET thread_id=? WHERE owner_id=?").run("saved-writer",writer.id);
  for(const task of [reader,writer]) {
    const m=f.agents.saveFollowup(task.id,`follow-${task.id}`,{expectedVersion:0,message:"Continue the saved scope",localTime:"2099-11-01T12:00",timezone:"UTC",policy:"when_available"}).messages.find(m=>m.schedule)!;
    f.db.db.prepare("UPDATE message_schedules SET run_at=? WHERE message_id=?").run(new Date(Date.now()-1000).toISOString(),m.id);
    f.db.db.prepare("INSERT OR IGNORE INTO pending_messages(message_id,dispatch_order) VALUES (?,1)").run(m.id);
  }
  // Followups require a previously established conversation.
  f.db.db.prepare("UPDATE agent_sessions SET thread_id=? WHERE owner_id=?").run("saved-reader",reader.id);
  f.db.db.prepare("UPDATE agent_sessions SET thread_id=? WHERE owner_id=?").run("saved-writer",writer.id);
  await f.drain();
  assert.equal(f.agents.workspace("task",reader.id).session.activeAccessMode,"read-only");
  assert.equal(f.agents.workspace("task",writer.id).session.runState,"not_started");
  assert.equal(f.agents.workspace("task",writer.id).messages.at(-1)?.schedule?.state,"pending");
});

test("legacy database migration defaults saved implementation and active grants to exclusive editing",async t=>{
  const f=fixture(t),task=f.task("Research title alone does not grant an exception");
  const before=f.tasks.getTask(task.id);
  for(const column of ["access_mode","active_access_mode","access_version","active_access_version","active_root_directory"]) f.db.db.exec(`ALTER TABLE agent_sessions DROP COLUMN ${column}`);
  f.restart();
  const w=f.agents.workspace("task",task.id);
  assert.equal(w.session.accessMode,"worktree-write");assert.equal(w.session.activeAccessMode,"worktree-write");
  assert.deepEqual(f.tasks.getTask(task.id),before);
  assert.equal(f.db.db.pragma("integrity_check",{simple:true}),"ok");
});

test("a newer user access choice supersedes an older running turn's mode request",async t=>{
  const f=fixture(t),reader=f.task();f.mode(reader.id,"read-only");
  await f.agents.send("task",reader.id,"Implement this page in source");
  f.mode(reader.id,"read-only"); // Explicitly reaffirm read-only while that turn is running.
  f.finish(reader.id,'<!-- qahwa-access:{"mode":"worktree-write","authorization":"Implement this page in source"} -->');
  assert.equal(f.agents.workspace("task",reader.id).session.accessMode,"read-only");
  assert.equal(f.agents.workspace("task",reader.id).hasPendingMessages,false);
});

test("startup acknowledges only the captured queue request and retains a later start intent",async t=>{
  const f=fixture(t),task=f.task();
  f.db.db.prepare("INSERT INTO scheduler_queue(task_id,requested_by,reason,created_at) VALUES (?,'orchestrator','First request','2026-01-01')").run(task.id);
  const message=await f.save(task.id,"Start authorized work");
  let release!:()=>void;f.gate(new Promise<void>(r=>{release=r;}));
  const starting=f.start(message.id);
  f.db.db.prepare("UPDATE scheduler_queue SET reason='Later request',created_at='2026-01-02' WHERE task_id=?").run(task.id);
  release();await starting;
  assert.equal((f.db.db.prepare("SELECT reason FROM scheduler_queue WHERE task_id=?").get(task.id) as any).reason,"Later request");
});

test("simultaneous direct starts reserve one editor before yielding and reject the conflicting start clearly",async t=>{
  const f=fixture(t),first=f.task("First editor"),second=f.task("Second editor");
  const results=await Promise.allSettled([f.agents.triggerTask(first.id),f.agents.triggerTask(second.id)]);
  assert.equal(f.calls.filter(c=>c.method==="turn/start").length,1);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason.code,"project_conflict");
});

test("an editing grant keeps its original worktree root when project settings change during startup",async t=>{
  const f=fixture(t),editor=f.task("Editor");
  let release!:()=>void;f.gate(new Promise<void>(r=>{release=r;}));
  const starting=f.agents.triggerTask(editor.id);
  // send() prepares attachments before reserving; wait until startup owns the lock.
  while(f.agents.workspace("task",editor.id).session.runState!=="running") await new Promise(r=>setTimeout(r,0));
  const newRoot=join(f.root,"relocated");mkdirSync(newRoot);
  f.db.db.prepare("UPDATE projects SET root_directory=? WHERE id=?").run(newRoot,f.project.id);
  const old=f.tasks.createProject({name:"Original worktree",prefix:"OLD",rootDirectory:f.worktree},"user");
  const next=f.task("Second editor",old.id);
  await assert.rejects(f.agents.triggerTask(next.id),{code:"project_conflict"});
  release();await starting;
  assert.equal(f.calls.find(c=>c.method==="thread/start")?.params.cwd,f.worktree);
});

test("access API validates mode, optimistic version, closed/terminal tasks, authentication and origin without starting work",async t=>{
  const f=fixture(t), task=f.task();
  f.agents.close();
  const auth=new AuthService(f.db,365),app=await buildApp(f.config,f.db);
  const url=`/api/tasks/${task.humanId}/access`,payload={mode:"read-only",expectedVersion:1};
  assert.equal((await app.inject({method:"PUT",url,payload})).statusCode,401);
  const now=new Date().toISOString();f.db.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(now,now);
  const session=auth.createSession("test","127.0.0.1","device"),headers={authorization:`Bearer ${session.token}`,origin:"http://localhost"};
  assert.equal((await app.inject({method:"PUT",url,headers:{...headers,origin:"https://invalid.example"},payload})).statusCode,403);
  assert.equal((await app.inject({method:"PUT",url,headers,payload:{...payload,mode:"guess"}})).statusCode,400);
  const result=await app.inject({method:"PUT",url,headers,payload});assert.equal(result.statusCode,200);
  assert.equal(result.json().workspace.session.accessMode,"read-only");assert.equal(f.calls.length,0);
  assert.equal((await app.inject({method:"PUT",url,headers,payload})).statusCode,409);
  f.tasks.transition(task.id,{to:"closed",outcome:"cancelled"},"user");
  assert.throws(()=>f.mode(task.id,"worktree-write"),{code:"task_closed"});
  const terminal=f.task("Terminal");f.db.db.prepare("UPDATE tasks SET session_kind='terminal' WHERE id=?").run(terminal.id);
  assert.throws(()=>f.mode(terminal.id,"read-only"),{code:"terminal_session"});
  await app.close();
});

test("terminal shells acquire the same exclusive worktree access while readers remain eligible",async t=>{
  const f=fixture(t), editor=f.task("Editor");f.active(editor.id);
  const terminals=new TerminalService(f.db,f.tasks);
  const now=new Date().toISOString();f.db.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(now,now);
  await assert.rejects(terminals.create(f.project.id,randomUUID(),"device"),{code:"project_conflict"});
  f.idle(editor.id);const shell=f.tasks.listTasks({tab:"active"}).find(t=>t.sessionKind==="terminal")!;
  await terminals.start(shell.id);
  await assert.rejects(f.agents.triggerTask(editor.id),{code:"project_conflict"});
  const reader=f.task();f.mode(reader.id,"read-only");await f.agents.triggerTask(reader.id);
  assert.equal(f.agents.workspace("task",reader.id).session.runState,"running");
  await terminals.close();
});
