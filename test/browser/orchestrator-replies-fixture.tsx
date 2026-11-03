// Only the local fixture endpoint is used. Conversation data comes from AgentService.
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "reply-source";
import { api } from "reply-api";
import "reply-styles";

Object.assign(api, {
  orchestratorPoll: async (cursor) => {
    const response = await fetch(`/fixture/workspace?${new URLSearchParams(cursor)}`);
    if (!response.ok) throw new Error("Fixture poll failed");
    return response.json();
  },
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<SessionWorkspace mode="orchestrator" orchestratorName="Moeen" onError={(message) => { window.fixtureError = message; }} />);
