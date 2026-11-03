// Local-only fixture using the real shared chat renderer and styles.
import { createRoot } from "react-dom/client";
import { SessionWorkspace } from "chat-source";
import { api } from "chat-api";
import "chat-styles";

const mode = new URLSearchParams(location.search).get("mode") === "task" ? "task" : "orchestrator";
const stamp = "2026-10-28T10:00:00.000Z";
const body = `### Automated portfolio observation:

Full observation with **formatted details** and [a reference](https://example.com/reference).

- [x] Preserve the complete observation
- [ ] Review the remaining work

${Array.from({ length: 20 }, (_, i) => `Observation ${i + 1}: task progress and dependencies remain available.`).join("\n\n")}

\`\`\`text
${"long-code-value-".repeat(60)}
\`\`\`

| Task | Description |
| --- | --- |
| QAH-0020 | ${"wide-table-value-".repeat(40)} |

${"long-unbroken-text-".repeat(60)}

Final observation: all original content is available.`;
const message = (id, role, text, metadata = null) => ({
  id, role, body: text, metadata, ownerType: mode, ownerId: "fixture", createdAt: stamp, itemId: null,
});
const state = {
  session: { id: "fixture", ownerType: mode, ownerId: "fixture", runState: "idle", surface: "chat", intakeState: "ready", generation: 1 },
  messages: [
    message("user", "user", "Please check the portfolio."),
    message("observation", "system", body, { attachments: [{ id: "notes", filename: "observation-notes.txt", mediaType: "text/plain", size: 128, status: "expired", previewUrl: "/unused" }] }),
    message("short", "system", "Session context refreshed."),
    message("long", "system", `**${"A very long system heading ".repeat(20)}**\n\nDetails beneath the long heading.`),
    message("empty", "system", ""),
    message("assistant", "assistant", "The **portfolio** is ready for review."),
  ],
  pendingRequests: [], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [],
};
const controls = window.systemMessagesFixture = {
  polls: 0,
  append() { state.messages.push(message("new", "system", "New automated observation.\n\nNew full details.")); },
};
const poll = async () => {
  controls.polls++;
  return { workspace: structuredClone(state), revision: String(controls.polls), messagesRevision: String(controls.polls),
    capacity: { activeTurns: 0, recommendedParallelism: 2, availableSlots: 2 } };
};
Object.assign(api, {
  task: async () => ({ task: { id: "fixture", humanId: "QAH-0020", title: "Compact system info", projectName: "Qahwa", status: "in_progress" } }),
  workspacePoll: poll, orchestratorPoll: poll,
  taskUnread: async () => ({ readState: { unreadCount: 0, unreadMessageIds: [] } }),
  clientDiagnostic: async () => {},
});
createRoot(document.getElementById("root")).render(<SessionWorkspace mode={mode} taskId={mode === "task" ? "fixture" : undefined} onError={(message) => { window.fixtureError = message; }} />);
