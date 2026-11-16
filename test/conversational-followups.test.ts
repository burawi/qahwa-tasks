import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFollowupTools } from "../src/mcp/followup-tools.js";
import { AgentService } from "../src/server/agent-service.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { AttachmentService } from "../src/server/attachment-service.js";
import { chatSchedulingInstructions } from "../src/server/chat-scheduling.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";

async function fixture(t: TestContext) {
  const root=mkdtempSync(join(tmpdir(),"qahwa-chat-followup-"));
  const config={host:"127.0.0.1",port:3022,publicBaseUrl:"http://localhost",dataDir:root,backupDir:join(root,"backups"),sessionDays:365};
  const db=new AppDatabase(config),tasks=new TaskService(db),attachments=new AttachmentService(db);
  let slots=0, sequence=0;
  class Agents extends AgentService { override capacity(){return {activeTurns:0,availableSlots:slots,recommendedParallelism:slots} as any;} }
  const agents=new Agents(db,tasks,attachments),requests:{method:string;params:any}[]=[];
  const codex=Reflect.get(agents,"codex");
  t.mock.method(codex,"initialize",async()=>{});
  t.mock.method(codex,"request",async(method:string,params:any)=>{requests.push({method,params});return method==="turn/start"?{turn:{id:`turn-${++sequence}`}}:{};});
  const project=tasks.createProject({name:"Chat scheduling",prefix:"CHAT",rootDirectory:root},"user");
  const task=tasks.createTask({projectId:project.id,title:"Inspect the result",status:"todo"},"user");tasks.transition(task.id,{to:"in_progress"},"codex");
  agents.workspace("task",task.id);db.db.prepare("UPDATE agent_sessions SET thread_id='existing-conversation',intake_state='ready',run_state='idle' WHERE owner_id=?").run(task.id);
  const server=new McpServer({name:"test-followups",version:"1"});registerFollowupTools(server,db,tasks);
  const client=new Client({name:"test-session",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);
  t.after(async()=>{await client.close();await server.close();agents.close();await new Promise(r=>setImmediate(r));attachments.close();db.close();rmSync(root,{recursive:true,force:true});});
  return {root,config,db,tasks,task,agents,attachments,requests,client,
    slots(n:number){slots=n;},
    async source(body="do this today at 9pm",zone:string|undefined="Africa/Tunis") {
      const w=await agents.send("task",task.id,body,false,"user",[],undefined,[],null,undefined,zone);
      return w.messages.at(-1)!;
    },
    async call(name:string,args:any){const response=await client.callTool({name,arguments:{taskId:task.humanId,...args}});const raw=(response.content as {text:string}[])[0]!.text;let value:any;try{value=JSON.parse(raw);}catch{value=raw;}return {error:Boolean(response.isError),value};},
    async start(id:string){return Reflect.get(agents,"startSavedMessage").call(agents,id);},
  };
}
const future={message:"Inspect the result and report the findings",localTime:"2099-11-01T21:00"};

test("normal Send captures the device clock and the same thread receives conversational scheduling tools",async t=>{
  const f=await fixture(t);f.slots(1);const source=await f.source();
  assert.equal(source.metadata?.submissionTimezone,"Africa/Tunis");assert.equal(source.metadata?.sessionGeneration,1);
  const resume=f.requests.find(r=>r.method==="thread/resume")!;
  assert.equal(resume.params.threadId,"existing-conversation");assert.match(resume.params.developerInstructions,/schedule_followup/);
  assert.match(resume.params.developerInstructions,new RegExp(source.id));assert.match(resume.params.developerInstructions,/do not carry out the requested work now/);
  assert.match(resume.params.developerInstructions,/saved immediately/);
  const tools=await f.client.listTools();assert.deepEqual(tools.tools.map(tool=>tool.name).sort(),["cancel_followup","edit_followup","list_followups","schedule_followup"]);
  const saved=await f.call("schedule_followup",{sourceMessageId:source.id,...future});assert.equal(saved.error,false);
  assert.equal(saved.value.timezone,"Africa/Tunis");assert.equal(saved.value.policy,"when_available");assert.equal(saved.value.runAt,"2099-11-01T20:00:00.000Z");
  assert.equal(f.requests.filter(r=>r.method==="turn/start").length,1,"Only the scheduling conversation runs now");
  assert.equal(f.db.db.prepare("SELECT 1 FROM pending_messages WHERE message_id=?").get(saved.value.messageId),undefined);
});

test("one conversational request is retry-safe, including after edits, cancellation and restart",async t=>{
  const f=await fixture(t),source=await f.source();
  const a=(await f.call("schedule_followup",{sourceMessageId:source.id,...future})).value;
  const b=(await f.call("schedule_followup",{sourceMessageId:source.id,...future,localTime:"2099-12-02T23:00"})).value;
  assert.equal(a.messageId,b.messageId);assert.equal(b.localTime,a.localTime);
  const edit=await f.call("edit_followup",{messageId:a.messageId,expectedVersion:a.version,localTime:"2099-11-02T22:00"});assert.equal(edit.error,false);
  assert.equal(edit.value.message,future.message);assert.equal(edit.value.version,2);
  const stale=await f.call("edit_followup",{messageId:a.messageId,expectedVersion:1,message:"stale"});assert.equal(stale.error,true);
  const retry=(await f.call("schedule_followup",{sourceMessageId:source.id,...future})).value;assert.equal(retry.localTime,edit.value.localTime);
  const cancel=await f.call("cancel_followup",{messageId:a.messageId,expectedVersion:2});assert.equal(cancel.error,false);
  const cancelled=(await f.call("schedule_followup",{sourceMessageId:source.id,...future})).value;assert.equal(cancelled.state,"cancelled");
  const reopened=new AppDatabase(f.config);try {assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM message_schedules").get().n,1);}finally{reopened.close();}
});

test("relative dates are anchored to submission in the device timezone across queue delays",async t=>{
  const f=await fixture(t),source=await f.source();source.createdAt="2027-01-01T23:30:00.000Z";source.metadata!.submissionTimezone="Asia/Tokyo";
  const instructions=chatSchedulingInstructions(source,false,new Date("2027-01-03T12:00:00Z"));
  assert.match(instructions,/2027-01-02T08:30/);assert.match(instructions,/2027-01-03T12:00/);assert.match(instructions,/submission clock/);
  assert.match(instructions,/Examples, quotes, code, deadlines/);assert.match(instructions,/genuinely ambiguous/);
});

test("explicit user timezone overrides the captured zone; missing zone and invalid DST never persist",async t=>{
  const f=await fixture(t),source=await f.source();
  const saved=await f.call("schedule_followup",{sourceMessageId:source.id,...future,timezone:"Asia/Tokyo"});assert.equal(saved.value.runAt,"2099-11-01T12:00:00.000Z");
  for(const [zone,time] of [["America/New_York","2027-11-07T01:30"],["America/New_York","2027-03-14T02:30"],["Invalid/Zone","2099-11-01T21:00"]]){
    const another=await f.source();const response=await f.call("schedule_followup",{sourceMessageId:another.id,...future,timezone:zone,localTime:time});assert.equal(response.error,true);
  }
  const absent=await f.source("do this tomorrow at 9pm",undefined);
  // The helper defaults its argument, so explicitly remove the optional context for a legacy client.
  f.db.db.prepare("UPDATE chat_messages SET metadata_json='{}' WHERE id=?").run(absent.id);
  assert.equal((await f.call("schedule_followup",{sourceMessageId:absent.id,...future})).error,true);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM message_schedules").get().n,1);
});

test("requests delayed past their chosen time follow the original missed-time policy",async t=>{
  const f=await fixture(t);
  for(const policy of ["when_available","skip_if_missed"]){
    const source=await f.source();const submitted=new Date(Date.now()-600_000).toISOString(),local=new Date(Date.now()-180_000).toISOString().slice(0,16);
    f.db.db.prepare("UPDATE chat_messages SET created_at=?,metadata_json=? WHERE id=?").run(submitted,JSON.stringify({submissionTimezone:"UTC",sessionGeneration:1}),source.id);
    const result=await f.call("schedule_followup",{sourceMessageId:source.id,...future,localTime:local,policy});assert.equal(result.error,false);
    assert.equal(result.value.state,policy==="when_available"?"pending":"skipped");f.agents.messageSchedules.due();assert.equal(f.agents.messageSchedules.get(result.value.messageId)?.state,policy==="when_available"?"pending":"skipped");
  }
  const past=await f.source();assert.equal((await f.call("schedule_followup",{sourceMessageId:past.id,...future,localTime:"2000-01-01T21:00"})).error,true);
});

test("tool delivery waits for current work and resumes the same conversation without scheduling itself again",async t=>{
  const f=await fixture(t),source=await f.source(),saved=(await f.call("schedule_followup",{sourceMessageId:source.id,...future})).value;
  f.db.db.prepare("DELETE FROM pending_messages WHERE message_id=?").run(source.id);
  f.db.db.prepare("UPDATE message_schedules SET run_at=? WHERE message_id=?").run(new Date(Date.now()-100).toISOString(),saved.messageId);f.agents.messageSchedules.due();
  f.db.db.prepare("UPDATE agent_sessions SET run_state='running',active_turn_id='current' WHERE owner_id=?").run(f.task.id);f.slots(1);
  assert.equal(await f.start(saved.messageId),false);
  f.db.db.prepare("UPDATE agent_sessions SET run_state='idle',active_turn_id=NULL WHERE owner_id=?").run(f.task.id);
  assert.equal(await f.start(saved.messageId),true);
  const resume=f.requests.find(r=>r.method==="thread/resume")!;assert.equal(resume.params.threadId,"existing-conversation");
  assert.match(resume.params.developerInstructions,/already-saved scheduled follow-up/);assert.match(resume.params.developerInstructions,/Do not schedule it again/);
  assert.equal((await f.call("schedule_followup",{sourceMessageId:saved.messageId,...future})).error,true);
  assert.equal(f.requests.some(r=>["thread/start","turn/steer","turn/interrupt"].includes(r.method)),false);
});

test("chat tools preserve source attachments, reply context and canvas through pending retention",async t=>{
  const f=await fixture(t),now=new Date().toISOString();
  f.db.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(now,now);
  const upload=f.attachments.initiate("task",f.task.id,"device",{filename:"context.txt",mediaType:"text/plain",size:7});f.attachments.appendChunk(upload.id,"device",0,Buffer.from("context"));f.attachments.complete(upload.id,"device");
  const source=(await f.agents.send("task",f.task.id,"Check this file tomorrow at 9pm",false,"user",[upload.id],"device",[],null,undefined,"Africa/Tunis")).messages.at(-1)!;
  const saved=(await f.call("schedule_followup",{sourceMessageId:source.id,...future})).value;
  f.db.db.prepare("DELETE FROM pending_messages WHERE message_id=?").run(source.id);
  f.db.db.prepare("UPDATE attachment_uploads SET expires_at='2000-01-01' WHERE id=?").run(upload.id);
  assert.equal(f.attachments.cleanupStale(),0);assert.equal(readFileSync(f.attachments.resolveDownload("task",f.task.id,upload.id).path,"utf8"),"context");
  const child=f.agents.workspace("task",f.task.id).messages.find(m=>m.id===saved.messageId)!;assert.equal(child.metadata?.attachments?.[0]?.id,upload.id);
  await f.call("cancel_followup",{messageId:saved.messageId,expectedVersion:1});
  assert.ok(f.db.db.prepare("SELECT expires_at FROM attachment_uploads WHERE id=?").get(upload.id).expires_at>now);
});

test("source validation and restoration prevent cross-chat scheduling and revival",async t=>{
  const f=await fixture(t),source=await f.source();
  f.db.db.prepare("UPDATE chat_messages SET role='assistant' WHERE id=?").run(source.id);assert.equal((await f.call("schedule_followup",{sourceMessageId:source.id,...future})).error,true);
  f.db.db.prepare("UPDATE chat_messages SET role='user' WHERE id=?").run(source.id);
  f.tasks.transition(f.task.id,{to:"closed",outcome:"cancelled"},"user");f.tasks.restoreCodex(f.task.id,f.tasks.getTask(f.task.id).version);
  assert.equal((await f.call("schedule_followup",{sourceMessageId:source.id,...future})).error,true);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM message_schedules").get().n,0);
});

test("normal message endpoint validates and saves timezone without a separate scheduling form",async t=>{
  const f=await fixture(t);f.agents.close();const app=await buildApp(f.config,f.db,{generateTitle:async()=>"Title"});
  const now=new Date().toISOString();f.db.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(now,now);
  const token=new AuthService(f.db,365).createSession("Test","127.0.0.1","device").token,headers={authorization:`Bearer ${token}`,origin:f.config.publicBaseUrl};
  // Keep accepted requests pending; this endpoint test must not start a real model.
  f.db.db.prepare("UPDATE agent_sessions SET run_state='running' WHERE owner_id=?").run(f.task.id);
  try {
    const url=`/api/tasks/${f.task.humanId}/messages`,payload={message:"do this today at 9pm",timezone:"Africa/Tunis"};
    assert.equal((await app.inject({method:"POST",url,payload:{...payload,timezone:"Invalid/Zone"},headers})).statusCode,400);
    const response=await app.inject({method:"POST",url,payload,headers});assert.equal(response.statusCode,202);
    assert.equal(response.json().workspace.messages.at(-1).metadata.submissionTimezone,"Africa/Tunis");
    assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM message_schedules").get().n,0,"Interpretation belongs to the existing conversation");
  }finally{await app.close();}
});
