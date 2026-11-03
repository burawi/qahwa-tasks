import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "history-source";
import { api, connection } from "history-api";
import "history-styles";

const params = new URLSearchParams(location.search);
await connection.connect();
let switchChat, connect;
const originalPage = api.messagePage;
const originalTaskPoll = api.workspacePoll;
const originalControlPoll = api.orchestratorPoll;
const fixture = window.historyFixture = {
  errors: [], failOlder: false, holdOlder: false, olderWaiting: false, releaseOlder: null,
  holdPoll: false, pollWaiting: false, releasePoll: null,
  switch(mode, taskId) { switchChat({ mode, taskId }); },
  connect(value) { connect(value); },
};
api.messagePage = async (...args) => {
  if (!args[2].through && fixture.failOlder) { fixture.failOlder = false; throw new Error("Temporary history failure. Retry loading older messages."); }
  const result = await originalPage(...args);
  if (!args[2].through && fixture.holdOlder) {
    fixture.holdOlder = false; fixture.olderWaiting = true;
    await new Promise(resolve => { fixture.releaseOlder = resolve; }); fixture.olderWaiting = false;
  }
  return result;
};
const poll = original => async (...args) => {
  const result = await original(...args);
  if (fixture.holdPoll) {
    fixture.holdPoll = false; fixture.pollWaiting = true;
    await new Promise(resolve => { fixture.releasePoll = resolve; }); fixture.pollWaiting = false;
  }
  return result;
};
api.workspacePoll = poll(originalTaskPoll); api.orchestratorPoll = poll(originalControlPoll);
function Fixture() {
  const [chat, setChat] = useState({ mode: params.get("mode") || "task", taskId: params.get("task") });
  const [connected, setConnected] = useState(true);
  switchChat = setChat; connect = setConnected;
  return <SessionWorkspace mode={chat.mode} taskId={chat.mode === "task" ? chat.taskId : undefined}
    connected={connected} onError={message => fixture.errors.push(message)} />;
}
createRoot(document.getElementById("root")).render(<StrictMode><Fixture /></StrictMode>);
