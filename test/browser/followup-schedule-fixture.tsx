// Local-only fixture. All transitions, notifications and interruptions stay in memory.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "actions-source";
import { api } from "actions-api";
import "actions-styles";

const params = new URLSearchParams(location.search);
const task = {
  id: "fixture", humanId: "QAH-0051", title: "Scheduled follow-up",
  projectName: "Qahwa", status: "in_progress", canEdit: false,
  idleNotificationsEnabled: false, comments: [], outputs: [], description: { type: "doc", content: [] }, version: 1,
};
const document = { format: "web", artboard: { name: "Controls", width: 600, height: 500, background: "#eee7ff" },
  html: '<main data-qahwa-id="main">Canvas remains available</main>', css: 'main{padding:40px;font:24px sans-serif}' };
const design = { id: "page", name: "Controls", revision: 1, document };
const canvas = params.has("canvas");
const workspace = {
  session: { id: "session", ownerType: "task", ownerId: task.id, threadId: "saved-thread", runState: params.has("running") ? "running" : "idle", surface: canvas ? "design" : "chat", intakeState: "pending", generation: 1 },
  canScheduleFollowup: true, schedule: null, messages: [{id:"earlier",role:"assistant",body:"Earlier conversation remains here.",createdAt:"2026-10-30T12:00:00.000Z",metadata:null}],
  pendingRequests: [], design: canvas ? design : null, designPages: canvas ? [design] : [], selectedDesignPageId: canvas ? "page" : null, recentEvents: [], workActivities: [],
};
let setConnected;
const fixture = window.actionsFixture = {
  calls: [], fail: false, hold: false, release: null, refreshFail: false,
  setStatus(status) { task.status = status; task.canEdit = status === "todo"; },
  setRunState(state) { workspace.session.runState = state; },
  connect(value) { setConnected(value); },
  async operation(name, args = []) {
    this.calls.push({ name, args });
    if (this.fail) throw new Error("Temporary action failure. Please retry.");
    if (this.hold) await new Promise(resolve => { this.release = resolve; });
  },
};
const poll = async () => {
  if (fixture.refreshFail) throw new Error("Refresh unavailable");
  return { workspace: structuredClone(workspace), capacity: { activeTurns: 0, availableSlots: 1, recommendedParallelism: 1 } };
};
let messageSequence=0;
function scheduleFromChat(source) {
  source.pending=false;
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Tunis",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const id=`scheduled-${source.id}`;
  if(workspace.messages.some(m=>m.id===id)) return;
  fixture.calls.push({name:"schedule_followup_tool",args:[source.id,{designPageId:source.metadata.designPageId}]});
  workspace.messages.push({id,role:"user",body:"Review the result in this conversation",createdAt:new Date().toISOString(),metadata:{designPageId:source.metadata.designPageId,scheduledFromMessageId:source.id},schedule:{messageId:id,taskId:task.id,version:1,localTime:`${day}T21:00`,timezone:"Africa/Tunis",policy:"when_available",state:"pending",runAt:`${day}T20:00:00.000Z`,reason:null}});
  workspace.messages.push({id:`confirmed-${source.id}`,role:"assistant",body:`Scheduled for ${day} at 21:00 (Africa/Tunis).`,createdAt:new Date().toISOString(),metadata:null});
}
fixture.finishWork=()=>{workspace.session.runState="idle";for(const message of [...workspace.messages])if(message.pending)scheduleFromChat(message);};
const unread = async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } });
Object.assign(api, {
  sendTaskMessage: async (id,text,attachmentIds,designPageId,selectedExcerpt) => {
    await fixture.operation("sendTaskMessage",[id,text,attachmentIds,designPageId,selectedExcerpt]);
    const source={id:`request-${++messageSequence}`,role:"user",body:text,createdAt:new Date().toISOString(),metadata:{designPageId},pending:workspace.session.runState==="running"};
    workspace.messages.push(source);
    if(!source.pending)scheduleFromChat(source);
    return {workspace:structuredClone(workspace)};
  },
  saveFollowup: async (id, messageId, body) => {
    await fixture.operation("saveFollowup", [id, messageId, body]);
    if (fixture.conflict) throw new Error("Schedule changed. Your draft is kept. Reopen it before saving.");
    let message=workspace.messages.find(m=>m.id===messageId);
    if (body.expectedVersion !== (message?.schedule?.version ?? 0)) throw new Error("Schedule changed");
    if (!message) {message={id:messageId,role:"user",createdAt:new Date().toISOString(),metadata:{designPageId:body.designPageId}};workspace.messages.push(message);}
    message.body=body.message; message.version=(message.version ?? 0)+1;
    message.schedule={...body,version:body.expectedVersion+1,messageId,taskId:id,state:"pending",runAt:"2099-11-01T11:00:00.000Z",reason:null};
    return {workspace:structuredClone(workspace)};
  },
  cancelFollowup: async (id, messageId, version) => {
    await fixture.operation("cancelFollowup", [id,messageId,version]);
    const message=workspace.messages.find(m=>m.id===messageId);
    if (version!==message.schedule.version) throw new Error("Schedule changed");
    message.schedule.state="cancelled";message.schedule.version++;message.cancelledAt=new Date().toISOString();message.schedule.reason="Scheduled message removed";
    return {workspace:structuredClone(workspace)};
  },
  saveSchedule: async (id, body) => {
    await fixture.operation("saveSchedule", [id, body]);
    if (fixture.conflict) throw new Error("Schedule changed. Reload before saving.");
    if (body.expectedVersion !== (workspace.schedule?.version ?? 0)) throw new Error("Schedule changed");
    workspace.schedule = { ...body, version: body.expectedVersion+1, state: "pending", taskId:id,
      runAt: "2099-11-01T11:00:00.000Z", updatedAt: new Date().toISOString(), reason:null };
    return {workspace:structuredClone(workspace)};
  },
  cancelSchedule: async (id, version) => {
    await fixture.operation("cancelSchedule", [id, version]);
    workspace.schedule.state="cancelled"; workspace.schedule.version++;
    workspace.schedule.reason="Schedule removed; task remains open";
    return {workspace:structuredClone(workspace)};
  },

  task: async () => ({ task: structuredClone(task) }), workspacePoll: poll, orchestratorPoll: poll,
  taskUnread: unread, markTaskRead: unread, orchestratorUnread: unread, markOrchestratorRead: unread,
  userAvatar: async () => ({ avatar: null }), orchestratorAvatar: async () => ({ avatar: null }),
  transition: async (...args) => {
    await fixture.operation("transition", args);
    if (args[3] && !["backlog", "todo"].includes(task.status)) throw new Error("This task has already started. Refresh before cancelling it.");
    if (args[2] === "completed" && task.status !== "in_review") throw new Error("Only reviewed tasks can be completed");
    task.status = "closed"; return { task: structuredClone(task) };
  },
  interruptTask: async id => { await fixture.operation("interruptTask", [id]); workspace.session.runState = "idle"; },
  interruptOrchestrator: async () => { await fixture.operation("interruptOrchestrator"); workspace.session.runState = "idle"; },
  cleanOrchestrator: async () => { await fixture.operation("clean"); workspace.messages = []; },
  setIdleNotifications: async (_id, enabled) => {
    await fixture.operation("notifications", [enabled]); task.idleNotificationsEnabled = enabled; return { task: structuredClone(task) };
  },
  appPushSettings: async () => ({ publicKey: "AQID", subscribed: true }), saveAppPushSubscription: async () => {},
  clientDiagnostic: async () => {},
});
function Fixture() {
  const [connected, updateConnected] = useState(true);
  setConnected = updateConnected;
  return <SessionWorkspace mode={params.has("orchestrator") ? "orchestrator" : "task"} taskId={params.has("orchestrator") ? undefined : task.id}
    connected={connected} onError={message => { window.fixtureError = message; }} />;
}
createRoot(window.document.getElementById("root")).render(<StrictMode><Fixture /></StrictMode>);
