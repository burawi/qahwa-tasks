import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { App } from "chat-app";
import { connection, fetchMessageFile } from "chat-api";
import "chat-styles";

const params = new URLSearchParams(location.search);
if (params.has("initialPath")) history.replaceState({}, "", params.get("initialPath") + location.search);
await connection.connect();
window.mediaFixture = { fetchMessageFile };
const workspace = params.has("app") ? <App /> : <SessionWorkspace
  mode={params.get("mode") === "task" ? "task" : "orchestrator"}
  taskId={params.get("task")} onError={message => { window.fixtureError = message; }}
/>;
createRoot(document.getElementById("root")).render(<StrictMode>{workspace}</StrictMode>);
