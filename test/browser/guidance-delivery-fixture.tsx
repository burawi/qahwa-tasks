import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "reply-source";
import { api } from "reply-api";
import "reply-styles";
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "task" ? "task" : "orchestrator";
const poll = async (cursor) => {
  const response = await fetch(`/fixture/workspace?${new URLSearchParams({ ...cursor, mode })}`);
  if (!response.ok) throw new Error("Fixture poll failed");
  return response.json();
};
const unread = async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } });
Object.assign(api, { orchestratorPoll: poll, workspacePoll: (id, cursor) => poll(cursor), workspace: () => poll({}),
  task: async () => ({ task: { id: params.get("task"), humanId: "R0-0001", version: 1, title: "Guidance delivery check", projectName: "Qahwa", status: "in_progress", comments: [], outputs: [] } }),
  taskUnread: unread, markTaskRead: unread, orchestratorUnread: unread, markOrchestratorRead: unread,
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<SessionWorkspace mode={mode} taskId={mode === "task" ? params.get("task") : undefined} connected onError={message => { window.fixtureError = message; }} />);
