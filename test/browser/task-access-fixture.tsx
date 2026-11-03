import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const params=new URLSearchParams(location.search),mode=params.get("mode")==="orchestrator"?"orchestrator":"task";
const canvas=params.get("canvas")==="1";
const document={format:"web",artboard:{width:390,height:500,background:"#fff",name:"Operator"},html:'<main data-qahwa-id="operator">Operator preparation</main>',css:"main{padding:20px}"};
const initial={
  session:{id:"fixture",ownerType:mode,ownerId:"fixture",threadId:"saved-thread",activeTurnId:null,runState:"idle",surface:canvas?"design":"chat",intakeState:"ready",generation:1,accessMode:"read-only",activeAccessMode:"read-only",accessVersion:1,accessReason:null},
  messages:[{id:"saved",ownerType:mode,ownerId:"fixture",role:"user",body:"Keep the Operator canvas and saved history",metadata:null,itemId:null,pending:false,createdAt:new Date().toISOString()}],
  pendingRequests:[],design:canvas?{document,revision:1}:null,designPages:canvas?[{id:"page",name:"Operator",document,revision:1}]:[],selectedDesignPageId:canvas?"page":null,recentEvents:[],workActivities:[],
};
const key=`access-${params}`,read=()=>JSON.parse(localStorage.getItem(key)||"null")||structuredClone(initial);
const task={id:"fixture",humanId:"WAS-0013",version:1,title:"Operator canvas preparation",projectName:"Wassala",status:"in_progress",comments:[],outputs:[]};
const controls=window.accessFixture={calls:[],errors:[],offline:false};
const full=async()=>({workspace:read(),capacity:{activeTurns:1,availableSlots:1},revision:JSON.stringify(read()),messagesRevision:"1"});
const unread=async()=>({readState:{unreadCount:0,unreadMessageIds:[]}});
Object.assign(api,{
  task:async()=>({task}),workspace:full,workspacePoll:full,orchestrator:full,orchestratorPoll:full,
  taskUnread:unread,markTaskRead:unread,orchestratorUnread:unread,markOrchestratorRead:unread,
  setTaskAccess:async(id,mode,version)=>{
    controls.calls.push([id,mode,version]);
    const state=read();state.session.accessMode=mode;state.session.accessVersion++;
    state.session.accessReason=mode==="worktree-write"?"Waiting for exclusive editing access: WAS-0012 is active in the same worktree. Editing can start after it releases access.":null;
    localStorage.setItem(key,JSON.stringify(state));return{workspace:state};
  },
  clientDiagnostic:async()=>{},
});
createRoot(window.document.getElementById("root")).render(<SessionWorkspace mode={mode} taskId={mode==="task"?"fixture":undefined} connected onError={message=>controls.errors.push(message)}/>);
