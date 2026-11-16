import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../src/server/agent-service.js';
import { SessionResources } from '../src/server/session-resources.js';
import { AppDatabase } from '../src/server/database.js';
import { TaskService } from '../src/server/task-service.js';
import { AttachmentService } from '../src/server/attachment-service.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'qahwa-resource-'));
  const config = { host: '127.0.0.1', port: 0, publicBaseUrl: 'http://localhost', dataDir: root, backupDir: join(root, 'backups'), sessionDays: 365 };
  const db = new AppDatabase(config), tasks = new TaskService(db), attachments = new AttachmentService(db);
  const agents = new AgentService(db, tasks, attachments);
  const client = Reflect.get(agents, 'codex');
  // Keep these state-machine tests on one mocked transport. Dedicated task
  // controller isolation has its own focused test below.
  t.mock.method(agents as any, 'runtimeForOwner', () => client);
  const calls: Array<{method: string; params: any}> = [];
  const loaded = new Set<string>();
  const runtime = new Map<string, string>();
  let hook: (method: string, params: any) => Promise<void> = async () => {};
  t.mock.method(client, 'initialize', async () => {});
  Object.defineProperty(client, 'ready', { configurable: true, get: () => true });
  t.mock.method(client, 'request', async (method: string, params: any) => {
    calls.push({ method, params });
    await hook(method, params);
    if (method === 'thread/loaded/list') return { data: [...loaded], nextCursor: null };
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: runtime.get(params.threadId) ?? 'idle' } } };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    if (method === 'thread/start') { loaded.add('new-thread'); return { thread: { id: 'new-thread' } }; }
    if (method === 'turn/start') return { turn: { id: 'new-turn' } };
    return {};
  });
  const capacity = agents.capacity();
  t.mock.method(agents, 'capacity', () => ({ ...capacity, availableSlots: 0 }));
  const project = tasks.createProject({ name: 'Resources', prefix: 'RES', rootDirectory: root }, 'user');
  const owner = (type: 'task' | 'orchestrator' = 'task', state = 'idle') => {
    const id = type === 'task' ? tasks.createTask({ projectId: project.id, title: 'Preserve saved conversation', status: 'todo' }, 'user').id : 'main';
    agents.workspace(type, id);
    const threadId = `thread-${id}`;
    db.db.prepare("UPDATE agent_sessions SET thread_id=?,intake_state='ready',run_state=?,updated_at=? WHERE owner_type=? AND owner_id=?")
      .run(threadId, state, new Date(Date.now()-120_000).toISOString(), type, id);
    loaded.add(threadId);
    return { id, type, threadId };
  };
  const message = (id: string, body = 'Saved queued message') => {
    db.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,created_at) VALUES (?,'task',?,'user',?,?)").run(`message-${id}`,id,body,new Date().toISOString());
    db.db.prepare('INSERT INTO pending_messages(message_id) VALUES (?)').run(`message-${id}`);
    return `message-${id}`;
  };
  t.after(async () => { await agents.close().catch(() => undefined); attachments.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, db, tasks, agents, client, calls, loaded, runtime, owner, message,
    hook(fn: typeof hook) { hook = fn; },
    tick: () => Reflect.get(agents,'releaseInactiveSessions').call(agents) as Promise<void>,
    events: (message: any) => Reflect.get(agents,'handleCodexMessage').call(agents,message),
    slots: () => t.mock.method(agents,'capacity',() => ({...capacity,availableSlots:1})),
    releases: () => calls.filter(x=>x.method==='thread/unsubscribe').map(x=>x.params.threadId),
  };
}

for (const type of ['task','orchestrator'] as const) for (const state of ['idle','interrupted','failed']) {
  test(`releases ${type} ${state} once and resumes the same thread with saved history`, async t => {
    const f=fixture(t), o=f.owner(type,state);
    const before=f.agents.workspace(type,o.id);
    await f.tick(); await f.tick();
    assert.deepEqual(f.releases(),[o.threadId]);
    assert.deepEqual({ ...f.agents.workspace(type,o.id), recentEvents: [] },before);
    assert.equal(f.calls.filter(x=>x.method==='thread/read').length,1,'do not refresh an unsubscribed thread during its grace period');
    f.slots();
    await f.agents.send(type,o.id,'Continue my saved conversation');
    const resume=f.calls.find(x=>x.method==='thread/resume');
    assert.equal(resume?.params.threadId,o.threadId);
    assert.equal(f.calls.some(x=>x.method==='thread/start'),false);
    assert.equal(f.agents.workspace(type,o.id).session.threadId,o.threadId);
    f.events({method:'turn/completed',params:{threadId:o.threadId,turn:{id:'new-turn',status:'completed'}}});
    f.db.db.prepare('UPDATE agent_sessions SET updated_at=? WHERE owner_id=?').run(new Date(Date.now()-120_000).toISOString(),o.id);
    await f.tick();
    assert.deepEqual(f.releases(),[o.threadId,o.threadId]);
  });
}

test('keeps running, waiting, starting, active runtime and approval sessions subscribed',async t=>{
  const f=fixture(t);
  f.owner('task','running'); f.owner('task','waiting');
  const starting=f.owner(), turn=f.owner(), approval=f.owner(), actualActive=f.owner();
  f.db.db.prepare("UPDATE agent_sessions SET starting_message_id='reserved' WHERE owner_id=?").run(starting.id);
  f.db.db.prepare("UPDATE agent_sessions SET active_turn_id='active' WHERE owner_id=?").run(turn.id);
  f.db.db.prepare("INSERT INTO pending_requests(id,owner_type,owner_id,request_type,payload_json,created_at) VALUES ('request','task',?,'permissions','{}',?)").run(approval.id,new Date().toISOString());
  f.runtime.set(actualActive.threadId,'active');
  await f.tick(); assert.deepEqual(f.releases(),[]);
});

test('idle grace applies to open sessions; UI and separate-connection MCP closure are discovered without callbacks',async t=>{
  const f=fixture(t), warm=f.owner(), ui=f.owner(), mcp=f.owner();
  for(const o of [warm,ui,mcp]) f.db.db.prepare('UPDATE agent_sessions SET updated_at=? WHERE owner_id=?').run(new Date().toISOString(),o.id);
  f.tasks.transition(ui.id,{to:'closed',outcome:'cancelled',onlyIfUnstarted:true},'user');
  // MCP writes through another TaskService/SQLite connection, not AgentService.
  const other = new AppDatabase(f.config);
  try { new TaskService(other).transition(mcp.id,{to:'closed',outcome:'cancelled',explicitUserInstruction:'Cancel this task'},'codex'); }
  finally { other.close(); }
  await f.tick(); assert.deepEqual(f.releases().sort(),[ui.threadId,mcp.threadId].sort());
  assert.equal(f.agents.workspace('task',warm.id).session.runState,'idle');
});

test('active work must pause before MCP closure and remains subscribed until then',async t=>{
  const f=fixture(t),o=f.owner('task','running');
  f.tasks.transition(o.id,{to:'in_progress'},'codex');
  assert.throws(()=>f.tasks.transition(o.id,{to:'closed',outcome:'cancelled',explicitUserInstruction:'Cancel'},'codex'),{code:'task_running'});
  await f.tick(); assert.deepEqual(f.releases(),[]);
  f.events({method:'turn/completed',params:{threadId:o.threadId,turn:{id:'old-turn',status:'interrupted'}}});
  f.tasks.transition(o.id,{to:'closed',outcome:'cancelled',explicitUserInstruction:'Cancel'},'codex');
  await f.tick(); assert.deepEqual(f.releases(),[o.threadId]);
});

test('queued messages, reserved/due follow-ups, handoffs and observations block cleanup',async t=>{
  const f=fixture(t),queued=f.owner(),handoff=f.owner(),locked=f.owner(),schedule=f.owner(),observed=f.owner('orchestrator');
  f.message(queued.id);
  f.db.db.prepare("INSERT INTO scheduler_queue(task_id,requested_by,reason,created_at) VALUES (?,'intake','Saved handoff',?)").run(handoff.id,new Date().toISOString());
  Reflect.get(f.agents,'handoffs').add(locked.id);
  f.db.db.prepare("INSERT INTO task_schedules(task_id,version,local_time,timezone,run_at,policy,state,updated_at) VALUES (?,1,'2020-01-01T12:00','UTC','2020-01-01T12:00:00Z','when_available','reserved',?)").run(schedule.id,new Date().toISOString());
  Reflect.get(f.agents,'orchestratorObservations').push('Pending portfolio follow-up');
  await f.tick(); assert.deepEqual(f.releases(),[]);
  assert.equal(f.agents.workspace('task',queued.id).messages[0]?.pending,true);
});

test('future follow-up unloads safely then scheduled delivery resumes the saved thread',async t=>{
  const f=fixture(t),o=f.owner(),message=f.message(o.id);
  const future=new Date(Date.now()+3600_000).toISOString();
  f.db.db.prepare("INSERT INTO message_schedules(message_id,task_id,version,local_time,timezone,run_at,policy,state,updated_at) VALUES (?,?,1,'2099-01-01T12:00','UTC',?,'when_available','pending',?)").run(message,o.id,future,new Date().toISOString());
  const schedule=f.agents.workspace('task',o.id).messages[0]?.schedule;
  await f.tick(); assert.deepEqual(f.releases(),[o.threadId]);
  assert.deepEqual(f.agents.workspace('task',o.id).messages[0]?.schedule,schedule);
  f.db.db.prepare("UPDATE message_schedules SET run_at='2020-01-01T12:00:00Z' WHERE message_id=?").run(message);
  f.slots();
  await Reflect.get(f.agents,'startSavedMessage').call(f.agents,message);
  assert.equal(f.calls.find(x=>x.method==='thread/resume')?.params.threadId,o.threadId);
  assert.equal(f.agents.workspace('task',o.id).messages[0]?.pending,false);
});

for(const change of ['queued','starting','approval','restore','binding','handoff'] as const) {
  test(`rechecks ${change} race after runtime read before unsubscribe`,async t=>{
    const f=fixture(t),o=f.owner();
    f.hook(async method=>{
      if(method!=='thread/read')return;
      if(change==='queued') f.message(o.id);
      if(change==='starting') f.db.db.prepare("UPDATE agent_sessions SET run_state='running',starting_message_id='new-message' WHERE owner_id=?").run(o.id);
      if(change==='approval') f.db.db.prepare("INSERT INTO pending_requests(id,owner_type,owner_id,request_type,payload_json,created_at) VALUES ('race','task',?,'user_input','{}',?)").run(o.id,new Date().toISOString());
      if(change==='restore') { f.tasks.transition(o.id,{to:'closed',outcome:'cancelled'},'user'); f.tasks.restoreCodex(o.id,f.tasks.getTask(o.id).version); }
      if(change==='binding') f.db.db.prepare("UPDATE agent_sessions SET thread_id='replacement' WHERE owner_id=?").run(o.id);
      if(change==='handoff') Reflect.get(f.agents,'handoffs').add(o.id);
    });
    await f.tick(); assert.deepEqual(f.releases(),[]);
  });
}

test('resume waits for in-flight unsubscribe; late closed notification preserves the new turn',async t=>{
  const f=fixture(t),o=f.owner(),entered=deferred(),finish=deferred();
  f.hook(async method=>{if(method==='thread/unsubscribe'){entered.resolve();await finish.promise;}});
  const cleanup=f.tick(); await entered.promise;
  f.slots(); const sending=f.agents.send('task',o.id,'Resume during release');
  await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.some(x=>x.method==='thread/resume'),false);
  finish.resolve(); await Promise.all([cleanup,sending]);
  assert.deepEqual(f.calls.filter(x=>['thread/unsubscribe','thread/resume','turn/start'].includes(x.method)).map(x=>x.method),['thread/unsubscribe','thread/resume','turn/start']);
  const before=f.agents.workspace('task',o.id);
  f.events({method:'thread/closed',params:{threadId:o.threadId}});
  f.events({method:'thread/status/changed',params:{threadId:o.threadId,status:{type:'notLoaded'}}});
  assert.deepEqual(f.agents.workspace('task',o.id),before);
});

test('failed unsubscribe retries, does not block resume or use archive/process killing',async t=>{
  const f=fixture(t),o=f.owner(); let failures=1;
  f.hook(async method=>{if(method==='thread/unsubscribe' && failures-->0)throw new Error('Transient cleanup failure');});
  await f.tick(); await f.tick(); assert.deepEqual(f.releases(),[o.threadId,o.threadId]);
  assert.equal(f.calls.some(x=>x.method==='thread/archive'),false);
  f.slots(); await f.agents.send('task',o.id,'Continue');
  assert.equal(f.calls.find(x=>x.method==='thread/resume')?.params.threadId,o.threadId);
});

test('resume failure preserves the saved binding and pending message instead of creating a replacement',async t=>{
  const f=fixture(t),o=f.owner(); await f.tick();
  f.hook(async method=>{if(method==='thread/resume')throw new Error('Conversation temporarily unavailable');});
  f.slots(); await f.agents.send('task',o.id,'Keep this request');
  const workspace=f.agents.workspace('task',o.id);
  assert.equal(workspace.session.threadId,o.threadId); assert.equal(workspace.messages[0]?.pending,true);
  assert.equal(f.calls.some(x=>x.method==='thread/start'||x.method==='turn/start'),false);
});

test('unknown loaded threads are untouched; stale known bindings are reclaimed; never launches Codex only for cleanup',async t=>{
  const f=fixture(t),o=f.owner();f.loaded.add('foreign-or-child-thread');
  await f.tick(); assert.deepEqual(f.releases(),[o.threadId]);
  const count=f.calls.length;
  Object.defineProperty(f.client,'ready',{get:()=>false});
  await f.tick();assert.equal(f.calls.length,count);
});

for(const state of ['completed','interrupted','failed'])test(`confirmed ${state} expires obsolete approval RPCs and permits cleanup`,async t=>{
  const f=fixture(t),o=f.owner('task','waiting');
  f.db.db.prepare("UPDATE agent_sessions SET active_turn_id='turn' WHERE owner_id=?").run(o.id);
  f.db.db.prepare("INSERT INTO pending_requests(id,owner_type,owner_id,rpc_request_id,request_type,payload_json,created_at) VALUES ('obsolete','task',?,'1','permissions','{}',?)").run(o.id,new Date().toISOString());
  await f.tick();assert.deepEqual(f.releases(),[]);
  f.events({method:'turn/completed',params:{threadId:o.threadId,turn:{id:'turn',status:state}}});
  assert.equal(f.agents.workspace('task',o.id).pendingRequests.length,0);
  f.db.db.prepare('UPDATE agent_sessions SET updated_at=? WHERE owner_id=?').run(new Date(Date.now()-120_000).toISOString(),o.id);
  await f.tick();assert.deepEqual(f.releases(),[o.threadId]);
});

test('resource gate deduplicates release and reevaluates eligibility before RPC ingress',async()=>{
  let calls=0, eligible=true;
  const gate=new SessionResources(async()=>{calls++;});
  const release=gate.release('thread',()=>eligible);eligible=false;
  await release;assert.equal(calls,0);
  eligible=true;await Promise.all([gate.release('thread',()=>eligible),gate.release('thread',()=>eligible)]);
  assert.equal(calls,1);
});

test('reviewed closure releases inactive runtime despite undeliverable old queue entries, preserving saved records',async t=>{
  const f=fixture(t),o=f.owner();f.message(o.id);
  f.tasks.transition(o.id,{to:'in_progress'},'codex');f.tasks.transition(o.id,{to:'in_review'},'codex');
  f.tasks.transition(o.id,{to:'closed',outcome:'completed'},'user');
  const before=f.agents.workspace('task',o.id);
  await f.tick();assert.deepEqual(f.releases(),[o.threadId]);
  assert.deepEqual(f.agents.workspace('task',o.id).messages,before.messages);
  assert.equal(f.tasks.getTask(o.id).outcome,'completed');
});

test('unload preserves attachments, canvas, outputs and saved associations',async t=>{
  const f=fixture(t),o=f.owner(),timestamp=new Date().toISOString();
  f.db.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('device','Test','',?,?)").run(timestamp,timestamp);
  const upload=Reflect.get(f.agents,'attachments').initiate('task',o.id,'device',{filename:'saved.txt',mediaType:'text/plain',size:7});
  const attachments=Reflect.get(f.agents,'attachments');
  attachments.appendChunk(upload.id,'device',0,Buffer.from('context'));attachments.complete(upload.id,'device');
  f.db.db.prepare("INSERT INTO chat_messages(id,owner_type,owner_id,role,body,metadata_json,created_at) VALUES ('saved','task',?,'user','Saved history',?,?)")
    .run(o.id,JSON.stringify({attachments:[{id:upload.id,filename:'saved.txt',mediaType:'text/plain',size:7}]}),timestamp);
  attachments.attachToMessage([upload.id],'saved');
  f.db.db.prepare("INSERT INTO design_pages(id,task_id,name,document_json,revision,created_at,updated_at) VALUES ('page',?,'Canvas',?,1,?,?)")
    .run(o.id,JSON.stringify({format:'web',artboard:{width:390,height:844,background:'#fff',name:'Canvas'},html:'<p data-qahwa-id="saved">Keep</p>',css:''}),timestamp,timestamp);
  f.tasks.addOutput(o.id,{summary:'Saved result',validation:['Passed'],limitations:[]},'codex');
  const tables=['agent_sessions','chat_messages','attachment_uploads','design_pages','task_outputs','tasks','task_schedules','message_schedules'];
  const read=()=>Object.fromEntries(tables.map(table=>[table,f.db.db.prepare(table==='agent_sessions'
    ? "SELECT * FROM agent_sessions WHERE owner_type='task' ORDER BY rowid" : `SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before=read();
  await f.tick();assert.deepEqual(f.releases(),[o.threadId]);assert.deepEqual(read(),before);
  assert.equal(readFileSync(attachments.resolveDownload('task',o.id,upload.id).path,'utf8'),'context');
});

test('one failed unsubscribe does not prevent other eligible sessions from releasing',async t=>{
  const f=fixture(t),first=f.owner(),second=f.owner();
  f.hook(async(method,params)=>{if(method==='thread/unsubscribe'&&params.threadId===first.threadId)throw new Error('Unavailable');});
  await f.tick();assert.deepEqual(f.releases(),[first.threadId,second.threadId]);
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM session_events WHERE event_type='session.cleanup_failed'").get().n,1);
});

test('loaded-thread pagination checks every known binding',async t=>{
  const f=fixture(t),a=f.owner(),b=f.owner();
  const request=f.client.request.bind(f.client), cursors: unknown[]=[];
  t.mock.method(f.client,'request',async(method:string,params:any)=>{
    if(method!=='thread/loaded/list')return request(method,params);
    cursors.push(params.cursor);
    return params.cursor ? {data:[b.threadId],nextCursor:null} : {data:[a.threadId],nextCursor:'page-2'};
  });
  await f.tick();assert.deepEqual(cursors,[null,'page-2']);assert.deepEqual(f.releases(),[a.threadId,b.threadId]);
});

test('completion before turn/start acknowledgement remains idle and eligible for cleanup',async t=>{
  const f=fixture(t),o=f.owner();f.slots();
  f.hook(async method=>{if(method==='turn/start') f.events({method:'turn/completed',params:{threadId:o.threadId,turn:{id:'new-turn',status:'completed'}}});});
  await f.agents.send('task',o.id,'A quick local turn');
  assert.equal(f.agents.workspace('task',o.id).session.runState,'idle');
  assert.equal(f.agents.workspace('task',o.id).session.activeTurnId,null);
  assert.equal(f.agents.workspace('task',o.id).messages[0]?.pending,false);
  f.db.db.prepare('UPDATE agent_sessions SET updated_at=? WHERE owner_id=?').run(new Date(Date.now()-120_000).toISOString(),o.id);
  await f.tick();assert.deepEqual(f.releases(),[o.threadId]);
});

test('pause reconciles a stale runtime turn and repeated requests stay idempotent',async t=>{
  const f=fixture(t),o=f.owner('task','running');
  f.db.db.prepare("UPDATE agent_sessions SET active_turn_id='stale-turn' WHERE owner_id=?").run(o.id);
  f.runtime.set(o.threadId,'idle');
  await f.agents.interrupt('task',o.id);
  await f.agents.interrupt('task',o.id);
  const session=f.agents.workspace('task',o.id).session;
  assert.equal(session.runState,'interrupted');
  assert.equal(session.activeTurnId,null);
  assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),false);
});

test('acknowledged pause verifies runtime stop before releasing the task',async t=>{
  const f=fixture(t),o=f.owner('task','running');
  f.db.db.prepare("UPDATE agent_sessions SET active_turn_id='active-turn' WHERE owner_id=?").run(o.id);
  f.runtime.set(o.threadId,'active');
  let forced=0;
  t.mock.method(f.client,'forceStop',async()=>{forced++;});
  f.hook(async method=>{if(method==='turn/interrupt')f.runtime.set(o.threadId,'idle');});
  await f.agents.interrupt('task',o.id);
  assert.equal(f.agents.workspace('task',o.id).session.runState,'interrupted');
  assert.equal(forced,0);
});

test('main orchestrator keeps supervisory instructions with operational runtime access',async t=>{
  const f=fixture(t),o=f.owner('orchestrator','idle');f.slots();
  await f.agents.send('orchestrator',o.id,'Inspect and stop the authorized stuck task');
  const resume=f.calls.find(call=>call.method==='thread/resume');
  const turn=f.calls.find(call=>call.method==='turn/start');
  assert.equal(resume?.params.sandbox,'danger-full-access');
  assert.equal(turn?.params.sandboxPolicy.type,'dangerFullAccess');
  assert.match(resume?.params.developerInstructions,/Never perform project implementation/);
  assert.match(resume?.params.developerInstructions,/inspect and control Qahwa's own task runtimes/);
});

test('unacknowledged pause force-stops only the selected task controller',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qahwa-interrupt-'));
  const config={host:'127.0.0.1',port:0,publicBaseUrl:'http://localhost',dataDir:root,backupDir:join(root,'backups'),sessionDays:365};
  const db=new AppDatabase(config),tasks=new TaskService(db),attachments=new AttachmentService(db),agents=new AgentService(db,tasks,attachments);
  t.after(()=>{agents.close();attachments.close();db.close();rmSync(root,{recursive:true,force:true});});
  const firstRoot=join(root,'first'),otherRoot=join(root,'other');mkdirSync(firstRoot);mkdirSync(otherRoot);
  const project=tasks.createProject({name:'Isolation',prefix:'ISO',rootDirectory:firstRoot},'user');
  const otherProject=tasks.createProject({name:'Other worktree',prefix:'OTH',rootDirectory:otherRoot},'user');
  const first=tasks.createTask({projectId:project.id,title:'Stuck task',status:'todo'},'user');
  const queued=tasks.createTask({projectId:project.id,title:'Waiting for the lock',status:'todo'},'user');
  const second=tasks.createTask({projectId:otherProject.id,title:'Other task',status:'todo'},'user');
  agents.workspace('task',first.id);agents.workspace('task',queued.id);agents.workspace('task',second.id);
  db.db.prepare("UPDATE agent_sessions SET intake_state='ready',access_mode='worktree-write' WHERE owner_type='task' AND owner_id=?").run(queued.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready',active_access_mode='worktree-write',active_root_directory=? WHERE owner_type='task' AND owner_id=?")
    .run('thread-first','turn-first',firstRoot,first.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready',active_access_mode='worktree-write',active_root_directory=? WHERE owner_type='task' AND owner_id=?")
    .run('thread-second','turn-second',otherRoot,second.id);
  const runtimeFor=Reflect.get(agents,'runtimeForOwner').bind(agents);
  const firstRuntime=runtimeFor('task',first.id),secondRuntime=runtimeFor('task',second.id);
  assert.notEqual(firstRuntime,secondRuntime);
  t.mock.method(firstRuntime,'initialize',async()=>{});
  t.mock.method(firstRuntime,'request',async(method:string)=>{
    if(method==='thread/read')return {thread:{status:{type:'active'}}};
    if(method==='turn/interrupt')throw new Error('Codex request timed out');
    return {};
  });
  let forced=0;
  t.mock.method(firstRuntime,'forceStop',async()=>{forced++;});
  t.mock.method(agents as any,'waitForRuntimeStop',async()=>false);
  assert.match(agents.workspace('task',queued.id).session.accessReason!,/exclusive editing access/);
  assert.equal(agents.capacity().activeTurns,2);
  await agents.interrupt('task',first.id);
  await agents.interrupt('task',first.id);
  assert.equal(forced,1);
  assert.equal(agents.workspace('task',first.id).session.runState,'interrupted');
  assert.equal(agents.workspace('task',queued.id).session.accessReason,null);
  assert.equal(agents.capacity().activeTurns,1);
  assert.equal(agents.workspace('task',second.id).session.runState,'running');
  assert.equal(agents.workspace('task',second.id).session.activeTurnId,'turn-second');
});

test('failed task force-stop and unverifiable orchestrator stop remain running',async t=>{
  const f=fixture(t),task=f.owner('task','running');
  f.db.db.prepare("UPDATE agent_sessions SET active_turn_id='task-turn' WHERE owner_id=?").run(task.id);
  f.runtime.set(task.threadId,'active');
  f.hook(async method=>{if(method==='turn/interrupt')throw new Error('Interrupt timed out');});
  t.mock.method(f.agents as any,'waitForRuntimeStop',async()=>false);
  t.mock.method(f.client,'forceStop',async()=>{throw new Error('Process group survived');});
  await assert.rejects(f.agents.interrupt('task',task.id),/Process group survived/);
  assert.equal(f.agents.workspace('task',task.id).session.runState,'running');
  assert.equal(f.agents.workspace('task',task.id).session.activeTurnId,'task-turn');

  const orchestrator=f.owner('orchestrator','running');
  f.db.db.prepare("UPDATE agent_sessions SET active_turn_id='orchestrator-turn' WHERE owner_id='main'").run();
  f.runtime.set(orchestrator.threadId,'active');
  f.hook(async()=>{});
  await assert.rejects(f.agents.interrupt('orchestrator',orchestrator.id),{code:'interrupt_not_verified'});
  assert.equal(f.agents.workspace('orchestrator',orchestrator.id).session.runState,'running');
  assert.equal(f.agents.workspace('orchestrator',orchestrator.id).session.activeTurnId,'orchestrator-turn');
});

test('isolated force-stop terminates the selected app-server process group and leaves its neighbor alive',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qahwa-force-stop-')),log=join(root,'processes.log');
  writeFileSync(join(root,'codex'),`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs'),readline=require('node:readline');
const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.appendFileSync(process.env.QAH_FORCE_STOP_LOG,process.pid+':'+worker.pid+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id!==undefined)process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');});
setInterval(()=>{},1000);
`,{mode:0o700});
  const previousPath=process.env.PATH,previousLog=process.env.QAH_FORCE_STOP_LOG;
  process.env.PATH=`${root}:${previousPath}`;process.env.QAH_FORCE_STOP_LOG=log;
  const config={host:'127.0.0.1',port:0,publicBaseUrl:'http://localhost',dataDir:root,backupDir:join(root,'backups'),sessionDays:365};
  const db=new AppDatabase(config),tasks=new TaskService(db),attachments=new AttachmentService(db),agents=new AgentService(db,tasks,attachments);
  t.after(()=>{
    agents.close();attachments.close();db.close();
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousLog===undefined)delete process.env.QAH_FORCE_STOP_LOG;else process.env.QAH_FORCE_STOP_LOG=previousLog;
    rmSync(root,{recursive:true,force:true});
  });
  const project=tasks.createProject({name:'Process isolation',prefix:'PGI',rootDirectory:root},'user');
  const first=tasks.createTask({projectId:project.id,title:'First runtime'},'user');
  const second=tasks.createTask({projectId:project.id,title:'Second runtime'},'user');
  const runtimeFor=Reflect.get(agents,'runtimeForOwner').bind(agents);
  const firstRuntime=runtimeFor('task',first.id),secondRuntime=runtimeFor('task',second.id);
  await Promise.all([firstRuntime.initialize(),secondRuntime.initialize()]);
  const deadline=Date.now()+2_000;
  while((!readFileSync(log,'utf8').trim()||readFileSync(log,'utf8').trim().split('\n').length<2)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  const records=readFileSync(log,'utf8').trim().split('\n').map(line=>line.split(':').map(Number));
  const firstPid=Reflect.get(firstRuntime,'child').pid as number,secondPid=Reflect.get(secondRuntime,'child').pid as number;
  const firstWorker=records.find(([pid])=>pid===firstPid)?.[1],secondWorker=records.find(([pid])=>pid===secondPid)?.[1];
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  assert.ok(alive(firstPid!)&&alive(firstWorker!)&&alive(secondPid!)&&alive(secondWorker!));
  await firstRuntime.forceStop(50);
  assert.equal(alive(firstPid!),false);assert.equal(alive(firstWorker!),false);
  assert.ok(alive(secondPid!)&&alive(secondWorker!));
});

test('leader exit keeps the task running until its surviving command child is terminated and verified',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qahwa-leader-exit-')),log=join(root,'processes.log'),count=join(root,'count');
  writeFileSync(join(root,'codex'),`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs'),readline=require('node:readline');
const countFile=process.env.QAH_LEADER_EXIT_COUNT,previous=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8')):0,index=previous+1;
fs.writeFileSync(countFile,String(index));
const workerCode=index===1?'const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.env.QAH_WORKER_READY,"1");setInterval(()=>{},1000)':'setInterval(()=>{},1000)';
const workerReady=process.env.QAH_LEADER_EXIT_LOG+'.worker-'+index;
const worker=spawn(process.execPath,['-e',workerCode],{stdio:'ignore',env:{...process.env,QAH_WORKER_READY:workerReady}});
fs.appendFileSync(process.env.QAH_LEADER_EXIT_LOG,index+':'+process.pid+':'+worker.pid+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.id!==undefined)process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');
  if(request.method==='initialized'&&index===1){const exitWhenReady=()=>fs.existsSync(workerReady)?setTimeout(()=>process.exit(0),25):setTimeout(exitWhenReady,5);exitWhenReady();}
});
setInterval(()=>{},1000);
`,{mode:0o700});
  const previousPath=process.env.PATH,previousLog=process.env.QAH_LEADER_EXIT_LOG,previousCount=process.env.QAH_LEADER_EXIT_COUNT;
  process.env.PATH=`${root}:${previousPath}`;process.env.QAH_LEADER_EXIT_LOG=log;process.env.QAH_LEADER_EXIT_COUNT=count;
  const config={host:'127.0.0.1',port:0,publicBaseUrl:'http://localhost',dataDir:root,backupDir:join(root,'backups'),sessionDays:365};
  const db=new AppDatabase(config),tasks=new TaskService(db),attachments=new AttachmentService(db),agents=new AgentService(db,tasks,attachments);
  t.after(()=>{
    agents.close();attachments.close();db.close();
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousLog===undefined)delete process.env.QAH_LEADER_EXIT_LOG;else process.env.QAH_LEADER_EXIT_LOG=previousLog;
    if(previousCount===undefined)delete process.env.QAH_LEADER_EXIT_COUNT;else process.env.QAH_LEADER_EXIT_COUNT=previousCount;
    rmSync(root,{recursive:true,force:true});
  });
  const project=tasks.createProject({name:'Leader exit isolation',prefix:'LEX',rootDirectory:root},'user');
  const first=tasks.createTask({projectId:project.id,title:'Leader exits'},'user');
  const neighbor=tasks.createTask({projectId:project.id,title:'Neighbor remains'},'user');
  agents.workspace('task',first.id);agents.workspace('task',neighbor.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready' WHERE owner_type='task' AND owner_id=?")
    .run('thread-first','turn-first',first.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready' WHERE owner_type='task' AND owner_id=?")
    .run('thread-neighbor','turn-neighbor',neighbor.id);
  const runtimeFor=Reflect.get(agents,'runtimeForOwner').bind(agents);
  const firstRuntime=runtimeFor('task',first.id),neighborRuntime=runtimeFor('task',neighbor.id);
  await firstRuntime.initialize();await neighborRuntime.initialize();
  const records=()=>readFileSync(log,'utf8').trim().split('\n').map(line=>line.split(':').map(Number));
  const readyDeadline=Date.now()+2_000;
  while((!readFileSync(log,'utf8').trim()||records().length<2)&&Date.now()<readyDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  const [firstIndex,firstPid,firstWorker]=records().find(([index])=>index===1)!;
  const [,neighborPid,neighborWorker]=records().find(([index])=>index===2)!;
  assert.equal(firstIndex,1);
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const leaderDeadline=Date.now()+1_000;
  while(alive(firstPid)&&Date.now()<leaderDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(alive(firstPid),false);
  assert.equal(alive(firstWorker),true);
  assert.equal(agents.workspace('task',first.id).session.runState,'running');
  assert.equal(agents.workspace('task',first.id).session.activeTurnId,'turn-first');
  const cleanupDeadline=Date.now()+3_000;
  while((alive(firstWorker)||agents.workspace('task',first.id).session.runState==='running')&&Date.now()<cleanupDeadline)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(alive(firstWorker),false);
  assert.equal(agents.workspace('task',first.id).session.runState,'interrupted');
  assert.equal(agents.workspace('task',first.id).session.activeTurnId,null);
  assert.ok(alive(neighborPid)&&alive(neighborWorker));
  assert.equal(agents.workspace('task',neighbor.id).session.runState,'running');
  assert.equal(agents.workspace('task',neighbor.id).session.activeTurnId,'turn-neighbor');
});

test('failed leader cleanup retains the old process group for Pause retry without spawning or disturbing a neighbor',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qahwa-leader-retry-')),log=join(root,'processes.log'),count=join(root,'count');
  writeFileSync(join(root,'codex'),`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs'),readline=require('node:readline');
const countFile=process.env.QAH_LEADER_RETRY_COUNT,previous=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8')):0,index=previous+1;
fs.writeFileSync(countFile,String(index));
const workerCode=index===1?'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)':'setInterval(()=>{},1000)';
const worker=spawn(process.execPath,['-e',workerCode],{stdio:'ignore'});
fs.appendFileSync(process.env.QAH_LEADER_RETRY_LOG,index+':'+process.pid+':'+worker.pid+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.id!==undefined)process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');
  if(request.method==='initialized'&&index===1)setTimeout(()=>process.exit(0),25);
});
setInterval(()=>{},1000);
`,{mode:0o700});
  const previousPath=process.env.PATH,previousLog=process.env.QAH_LEADER_RETRY_LOG,previousCount=process.env.QAH_LEADER_RETRY_COUNT;
  process.env.PATH=`${root}:${previousPath}`;process.env.QAH_LEADER_RETRY_LOG=log;process.env.QAH_LEADER_RETRY_COUNT=count;
  const config={host:'127.0.0.1',port:0,publicBaseUrl:'http://localhost',dataDir:root,backupDir:join(root,'backups'),sessionDays:365};
  const db=new AppDatabase(config),tasks=new TaskService(db),attachments=new AttachmentService(db),agents=new AgentService(db,tasks,attachments);
  t.after(()=>{
    agents.close();attachments.close();db.close();
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousLog===undefined)delete process.env.QAH_LEADER_RETRY_LOG;else process.env.QAH_LEADER_RETRY_LOG=previousLog;
    if(previousCount===undefined)delete process.env.QAH_LEADER_RETRY_COUNT;else process.env.QAH_LEADER_RETRY_COUNT=previousCount;
    rmSync(root,{recursive:true,force:true});
  });
  const project=tasks.createProject({name:'Leader retry isolation',prefix:'LRI',rootDirectory:root},'user');
  const first=tasks.createTask({projectId:project.id,title:'Retry old group'},'user');
  const neighbor=tasks.createTask({projectId:project.id,title:'Unaffected neighbor'},'user');
  agents.workspace('task',first.id);agents.workspace('task',neighbor.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready' WHERE owner_type='task' AND owner_id=?")
    .run('thread-first','turn-first',first.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready' WHERE owner_type='task' AND owner_id=?")
    .run('thread-neighbor','turn-neighbor',neighbor.id);
  const runtimeFor=Reflect.get(agents,'runtimeForOwner').bind(agents);
  const firstRuntime=runtimeFor('task',first.id),neighborRuntime=runtimeFor('task',neighbor.id);
  const cleanup=t.mock.method(firstRuntime as any,'terminateProcessTree',async()=>{throw new Error('Simulated unverifiable survivor');});
  await firstRuntime.initialize();await neighborRuntime.initialize();
  const records=()=>readFileSync(log,'utf8').trim().split('\n').map(line=>line.split(':').map(Number));
  const readyDeadline=Date.now()+2_000;
  while((!readFileSync(log,'utf8').trim()||records().length<2)&&Date.now()<readyDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  const [,firstPid,firstWorker]=records().find(([index])=>index===1)!;
  const [,neighborPid,neighborWorker]=records().find(([index])=>index===2)!;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const failureDeadline=Date.now()+1_000;
  while((alive(firstPid)||!agents.workspace('task',first.id).session.lastError)&&Date.now()<failureDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(alive(firstPid),false);
  assert.equal(alive(firstWorker),true);
  assert.equal(agents.workspace('task',first.id).session.runState,'running');
  assert.equal(agents.workspace('task',first.id).session.activeTurnId,'turn-first');
  assert.match(agents.workspace('task',first.id).session.lastError!,/unverifiable survivor/i);
  assert.equal(readFileSync(count,'utf8'),'2');
  cleanup.mock.restore();
  await agents.interrupt('task',first.id);
  assert.equal(alive(firstWorker),false);
  assert.equal(agents.workspace('task',first.id).session.runState,'interrupted');
  assert.equal(agents.workspace('task',first.id).session.activeTurnId,null);
  assert.equal(readFileSync(count,'utf8'),'2');
  assert.ok(alive(neighborPid)&&alive(neighborWorker));
  assert.equal(agents.workspace('task',neighbor.id).session.runState,'running');
  assert.equal(agents.workspace('task',neighbor.id).session.activeTurnId,'turn-neighbor');
});

test('failed direct Pause clears its latch and retries the retained group without spawning or disturbing a neighbor',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qahwa-direct-retry-')),log=join(root,'processes.log'),count=join(root,'count');
  writeFileSync(join(root,'codex'),`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs'),readline=require('node:readline');
const countFile=process.env.QAH_DIRECT_RETRY_COUNT,previous=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8')):0,index=previous+1;
fs.writeFileSync(countFile,String(index));
const workerCode=index===1?'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)':'setInterval(()=>{},1000)';
const worker=spawn(process.execPath,['-e',workerCode],{stdio:'ignore'});
fs.appendFileSync(process.env.QAH_DIRECT_RETRY_LOG,index+':'+process.pid+':'+worker.pid+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id!==undefined)process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');});
setInterval(()=>{},1000);
`,{mode:0o700});
  const previousPath=process.env.PATH,previousLog=process.env.QAH_DIRECT_RETRY_LOG,previousCount=process.env.QAH_DIRECT_RETRY_COUNT;
  process.env.PATH=`${root}:${previousPath}`;process.env.QAH_DIRECT_RETRY_LOG=log;process.env.QAH_DIRECT_RETRY_COUNT=count;
  const config={host:'127.0.0.1',port:0,publicBaseUrl:'http://localhost',dataDir:root,backupDir:join(root,'backups'),sessionDays:365};
  const db=new AppDatabase(config),tasks=new TaskService(db),attachments=new AttachmentService(db),agents=new AgentService(db,tasks,attachments);
  t.after(async()=>{
    await agents.close().catch(()=>undefined);attachments.close();db.close();
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousLog===undefined)delete process.env.QAH_DIRECT_RETRY_LOG;else process.env.QAH_DIRECT_RETRY_LOG=previousLog;
    if(previousCount===undefined)delete process.env.QAH_DIRECT_RETRY_COUNT;else process.env.QAH_DIRECT_RETRY_COUNT=previousCount;
    rmSync(root,{recursive:true,force:true});
  });
  const project=tasks.createProject({name:'Direct Pause retry',prefix:'DPR',rootDirectory:root},'user');
  const first=tasks.createTask({projectId:project.id,title:'Failed direct Pause'},'user');
  const neighbor=tasks.createTask({projectId:project.id,title:'Neighbor stays alive'},'user');
  agents.workspace('task',first.id);agents.workspace('task',neighbor.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready' WHERE owner_type='task' AND owner_id=?")
    .run('thread-first','turn-first',first.id);
  db.db.prepare("UPDATE agent_sessions SET thread_id=?,active_turn_id=?,run_state='running',intake_state='ready' WHERE owner_type='task' AND owner_id=?")
    .run('thread-neighbor','turn-neighbor',neighbor.id);
  const runtimeFor=Reflect.get(agents,'runtimeForOwner').bind(agents);
  const firstRuntime=runtimeFor('task',first.id),neighborRuntime=runtimeFor('task',neighbor.id);
  await firstRuntime.initialize();await neighborRuntime.initialize();
  const records=()=>readFileSync(log,'utf8').trim().split('\n').map(line=>line.split(':').map(Number));
  const readyDeadline=Date.now()+2_000;
  while((!readFileSync(log,'utf8').trim()||records().length<2)&&Date.now()<readyDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  const [,firstPid,firstWorker]=records().find(([index])=>index===1)!;
  const [,neighborPid,neighborWorker]=records().find(([index])=>index===2)!;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  t.mock.method(agents as any,'waitForRuntimeStop',async()=>false);
  const leader=Reflect.get(firstRuntime,'child');
  const failedStop=t.mock.method(firstRuntime as any,'terminateProcessTree',async()=>{
    const exited=leader.exitCode!==null||leader.signalCode!==null?Promise.resolve():new Promise<void>(resolve=>leader.once('exit',()=>resolve()));
    leader.kill('SIGKILL');await exited;
    throw new Error('Simulated direct Pause verification failure');
  });
  await assert.rejects(agents.interrupt('task',first.id),/direct Pause verification failure/);
  assert.equal(alive(firstPid),false);assert.equal(alive(firstWorker),true);
  assert.equal(agents.workspace('task',first.id).session.runState,'running');
  assert.equal(agents.workspace('task',first.id).session.activeTurnId,'turn-first');
  assert.match(agents.workspace('task',first.id).session.lastError!,/direct Pause verification failure/i);
  assert.equal(Reflect.get(firstRuntime,'forceStopChild'),null);
  assert.equal(Reflect.get(firstRuntime,'child'),null);
  assert.equal(readFileSync(count,'utf8'),'2');
  failedStop.mock.restore();
  await agents.interrupt('task',first.id);
  assert.equal(alive(firstWorker),false);
  assert.equal(agents.workspace('task',first.id).session.runState,'interrupted');
  assert.equal(readFileSync(count,'utf8'),'2');
  assert.ok(alive(neighborPid)&&alive(neighborWorker));
  assert.equal(agents.workspace('task',neighbor.id).session.runState,'running');
});

test('application shutdown escalates and verifies every detached task process group before clearing runtimes',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qahwa-shutdown-groups-')),log=join(root,'processes.log'),count=join(root,'count');
  writeFileSync(join(root,'codex'),`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs'),readline=require('node:readline');
const countFile=process.env.QAH_SHUTDOWN_COUNT,previous=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8')):0,index=previous+1;
fs.writeFileSync(countFile,String(index));
const workerCode=index===1?'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)':'setInterval(()=>{},1000)';
const worker=spawn(process.execPath,['-e',workerCode],{stdio:'ignore'});
fs.appendFileSync(process.env.QAH_SHUTDOWN_LOG,index+':'+process.pid+':'+worker.pid+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id!==undefined)process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');});
setInterval(()=>{},1000);
`,{mode:0o700});
  const previousPath=process.env.PATH,previousLog=process.env.QAH_SHUTDOWN_LOG,previousCount=process.env.QAH_SHUTDOWN_COUNT;
  process.env.PATH=`${root}:${previousPath}`;process.env.QAH_SHUTDOWN_LOG=log;process.env.QAH_SHUTDOWN_COUNT=count;
  const config={host:'127.0.0.1',port:0,publicBaseUrl:'http://localhost',dataDir:root,backupDir:join(root,'backups'),sessionDays:365};
  const db=new AppDatabase(config),tasks=new TaskService(db),attachments=new AttachmentService(db),agents=new AgentService(db,tasks,attachments);
  t.after(async()=>{
    await agents.close().catch(()=>undefined);attachments.close();db.close();
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousLog===undefined)delete process.env.QAH_SHUTDOWN_LOG;else process.env.QAH_SHUTDOWN_LOG=previousLog;
    if(previousCount===undefined)delete process.env.QAH_SHUTDOWN_COUNT;else process.env.QAH_SHUTDOWN_COUNT=previousCount;
    rmSync(root,{recursive:true,force:true});
  });
  const project=tasks.createProject({name:'Shutdown groups',prefix:'SDG',rootDirectory:root},'user');
  const first=tasks.createTask({projectId:project.id,title:'TERM resistant child'},'user');
  const second=tasks.createTask({projectId:project.id,title:'Normal child'},'user');
  const runtimeFor=Reflect.get(agents,'runtimeForOwner').bind(agents);
  const firstRuntime=runtimeFor('task',first.id),secondRuntime=runtimeFor('task',second.id);
  await firstRuntime.initialize();await secondRuntime.initialize();
  const records=()=>readFileSync(log,'utf8').trim().split('\n').map(line=>line.split(':').map(Number));
  const readyDeadline=Date.now()+2_000;
  while((!readFileSync(log,'utf8').trim()||records().length<2)&&Date.now()<readyDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  const processes=records().flatMap(([,leader,worker])=>[leader,worker]);
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  assert.ok(processes.every(alive));
  await agents.close();
  assert.ok(processes.every(pid=>!alive(pid)));
  assert.equal(Reflect.get(firstRuntime,'processGroupId'),null);
  assert.equal(Reflect.get(secondRuntime,'processGroupId'),null);
  assert.equal(Reflect.get(firstRuntime,'child'),null);
  assert.equal(Reflect.get(secondRuntime,'child'),null);
  assert.equal(Reflect.get(agents,'taskCodex').size,0);
});

test('late interrupt acknowledgement cannot clear a newer queued turn',async t=>{
  const f=fixture(t),o=f.owner('task','running');
  f.runtime.set(o.threadId,'active');
  f.db.db.prepare("UPDATE agent_sessions SET active_turn_id='old-turn' WHERE owner_id=?").run(o.id);
  const entered=deferred(),finish=deferred();
  f.hook(async method=>{if(method==='turn/interrupt'){entered.resolve();await finish.promise;}});
  const interrupt=f.agents.interrupt('task',o.id);await entered.promise;
  f.events({method:'turn/completed',params:{threadId:o.threadId,turn:{id:'old-turn',status:'interrupted'}}});
  f.slots();await f.agents.send('task',o.id,'Next queued turn');
  finish.resolve();await interrupt;
  assert.equal(f.agents.workspace('task',o.id).session.activeTurnId,'new-turn');
  assert.equal(f.agents.workspace('task',o.id).session.runState,'running');
  await f.tick();assert.deepEqual(f.releases(),[]);
});

test('replayed completion during startup does not clear the reservation or approvals',async t=>{
  const f=fixture(t),o=f.owner();
  f.events({method:'turn/completed',params:{threadId:o.threadId,turn:{id:'old-turn',status:'completed'}}});
  f.slots();const entered=deferred(),finish=deferred();
  f.hook(async method=>{if(method==='thread/resume'){entered.resolve();await finish.promise;}});
  const sending=f.agents.send('task',o.id,'Next work');await entered.promise;
  f.events({method:'turn/completed',params:{threadId:o.threadId,turn:{id:'old-turn',status:'completed'}}});
  assert.equal(f.agents.workspace('task',o.id).session.runState,'running');
  await f.tick();assert.deepEqual(f.releases(),[]);
  finish.resolve();await sending;
  assert.equal(f.agents.workspace('task',o.id).session.activeTurnId,'new-turn');
});

test('late cleanup/request after service shutdown cannot spawn an app-server',async t=>{
  const f=fixture(t);f.owner();
  f.client.request.mock.restore();f.client.initialize.mock.restore();
  f.agents.close();
  await f.tick();
  await assert.rejects(f.client.request('thread/unsubscribe',{threadId:'saved'}),{code:'codex_closed'});
  await assert.rejects(f.client.initialize(),{code:'codex_closed'});
  assert.throws(()=>f.client.notify('initialized',{}),{code:'codex_closed'});
  assert.equal(Reflect.get(f.client,'child'),null);
});
