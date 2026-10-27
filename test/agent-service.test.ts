import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskImplementationHandoff, hasCurrentUserAuthorization, hasStandingDirectiveAuthorization, isolatedCodexEnvironment, parseAgentEnvelope, projectWorkActivities, recommendedParallelism } from "../src/server/agent-service.js";

test("agent envelope extracts task presence, surface, design, and orchestrator starts", () => {
  const response = parseAgentEnvelope(`Implemented the dashboard.\n\n<qahwa-design>{"format":"web","artboard":{"width":390,"height":844,"background":"#fff","name":"Dashboard"},"html":"<main data-qahwa-id='root'></main>","css":"main{min-height:100vh}"}</qahwa-design>\n<!-- qahwa-start:WAS-0012 -->\n<!-- qahwa-priority:WAS-0012, QAH-0004 -->\n<!-- qahwa:{"message":"Implemented","tone":"green","surface":"design","review":true} -->`);
  assert.equal(response.body, "Implemented the dashboard.");
  assert.equal(response.message, "Implemented");
  assert.equal(response.tone, "green");
  assert.equal(response.surface, "design");
  assert.equal(response.design?.artboard.width, 390);
  assert.equal(response.review, true);
  assert.deepEqual(response.startTasks, ["WAS-0012"]);
  assert.deepEqual(response.priorityTasks, ["WAS-0012", "QAH-0004"]);
});

test("agent envelope rejects executable design documents", () => {
  const response = parseAgentEnvelope(`<qahwa-design>{"format":"web","artboard":{"width":390,"height":844,"background":"#fff","name":"Unsafe"},"html":"<script>alert(1)</script>","css":""}</qahwa-design><!-- qahwa:{"message":"Draft","tone":"blue","surface":"design"} -->`);
  assert.equal(response.design, undefined);
  assert.match(response.body, /qahwa-design/);
});

test("capacity recommendation protects small or memory-pressured machines", () => {
  assert.equal(recommendedParallelism(4, 1024 ** 3, 8 * 1024 ** 3), 1);
  assert.equal(recommendedParallelism(4, 4 * 1024 ** 3, 8 * 1024 ** 3), 2);
  assert.equal(recommendedParallelism(12, 16 * 1024 ** 3, 32 * 1024 ** 3), 4);
  assert.equal(recommendedParallelism(12, 16 * 1024 ** 3, 32 * 1024 ** 3, 11), 1);
});

test("agent envelope extracts intake, silent supervision, and structured orchestrator controls", () => {
  const response = parseAgentEnvelope(`No user-facing update.\n<!-- qahwa-intake:{"ready":true} -->\n<!-- qahwa-silent -->\n<!-- qahwa-actions:[{"type":"start","taskId":"was-0001","authorization":"Retry"},{"type":"message","taskId":"QAH-0002","message":"Check the failing test","authorization":"guide it"},{"type":"interrupt","taskId":"MAJ-0003","authorization":"pause it"},{"type":"priority","taskIds":["MAJ-0003","WAS-0001"],"authorization":"use this order"}] -->`);
  assert.equal(response.intakeReady, true);
  assert.equal(response.silent, true);
  assert.deepEqual(response.actions, [
    { type: "start", taskId: "WAS-0001", authorization: "Retry" },
    { type: "message", taskId: "QAH-0002", message: "Check the failing test", authorization: "guide it" },
    { type: "interrupt", taskId: "MAJ-0003", authorization: "pause it" },
    { type: "priority", taskIds: ["MAJ-0003", "WAS-0001"], authorization: "use this order" },
  ]);
});

test("spawned Codex sessions cannot inherit Orca routing or parent session identity", () => {
  const environment = isolatedCodexEnvironment({
    PATH: "/bin", ORCA_TAB_ID: "orca-tab", ORCA_AGENT_HOOK_TOKEN: "secret",
    JCODE_RUNTIME_DIR: "/tmp/jcode", CODEX_SESSION_ID: "parent", CODEX_THREAD_ID: "thread",
    CODEX_TOOL_CALL_ID: "call", INVOCATION_ID: "invocation",
  });
  assert.deepEqual(environment, { PATH: "/bin" });
});

test("orchestrator actions require evidence from the current user turn, not keyword interpretation", () => {
  assert.equal(hasCurrentUserAuthorization("Retry", "Retry"), true);
  assert.equal(hasCurrentUserAuthorization("make the first one only", "the first one"), true);
  assert.equal(hasCurrentUserAuthorization("How would you handle them?", "start"), false);
  assert.equal(hasCurrentUserAuthorization(undefined, "Retry"), false);
});

test("standing directives authorize only their exact id and source quote", () => {
  const directive = { id: "directive-1", instruction: "Continue priority work when capacity is safe", sourceQuote: "continue the work once this task is done", createdAt: "2026-10-27T00:00:00.000Z" };
  assert.equal(hasStandingDirectiveAuthorization(directive, "directive-1", "continue the work"), true);
  assert.equal(hasStandingDirectiveAuthorization(directive, "directive-1", "when capacity is safe"), true);
  assert.equal(hasStandingDirectiveAuthorization(directive, "directive-2", "continue the work"), false);
  assert.equal(hasStandingDirectiveAuthorization(directive, "directive-1", "deploy everything"), false);
});

test("implementation handoff preserves clarified scope and blocks unrelated work", () => {
  const handoff = buildTaskImplementationHandoff({
    humanId: "WAS-0004", projectName: "Wassala", title: "Count distinct customer phone numbers",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Count all lifetime customer and recipient numbers" }] }] },
  }, [
    { role: "user", body: "Include customers and outbound order recipients." },
    { role: "assistant", body: "Confirmed: lifetime, every status, with a source breakdown." },
  ]);
  assert.match(handoff, /Count distinct customer phone numbers/);
  assert.match(handoff, /Include customers and outbound order recipients/);
  assert.match(handoff, /read-only by default/);
  assert.match(handoff, /Do not substitute adjacent work/);
});

test("orchestrator envelope can manage and use a standing directive", () => {
  const response = parseAgentEnvelope(`<!-- qahwa-actions:[{"type":"directive","enabled":true,"instruction":"Continue prioritized work when capacity is safe","authorization":"continue the work"},{"type":"start","taskId":"was-0001","authorization":"continue the work","directiveId":"directive-1"}] -->`);
  assert.deepEqual(response.actions, [
    { type: "directive", enabled: true, instruction: "Continue prioritized work when capacity is safe", authorization: "continue the work" },
    { type: "start", taskId: "WAS-0001", authorization: "continue the work", directiveId: "directive-1" },
  ]);
});

test("session events become useful Orca-style work activities without protocol noise", () => {
  const at = "2026-10-27T20:00:00.000Z";
  const event = (id: number, event_type: string, item: Record<string, unknown>) => ({
    id, event_type, created_at: at, payload_json: JSON.stringify({ payload: { item } }),
  });
  const activities = projectWorkActivities([
    event(1, "item/started", { id: "reason-1", type: "reasoning" }),
    event(2, "item/completed", { id: "reason-1", type: "reasoning" }),
    event(3, "item/started", { id: "command-1", type: "commandExecution", command: "npm test", cwd: "/workspace", status: "inProgress" }),
    event(4, "item/completed", { id: "command-1", type: "commandExecution", command: "npm test", cwd: "/workspace", status: "failed", exitCode: 1, aggregatedOutput: "1 test failed" }),
    event(5, "item/completed", { id: "message-1", type: "agentMessage", text: "Done" }),
  ], true);
  assert.equal(activities.length, 2);
  assert.deepEqual(activities.map(({ kind, title, status }) => ({ kind, title, status })), [
    { kind: "thinking", title: "Thought through the next step", status: "done" },
    { kind: "error", title: "Command failed", status: "error" },
  ]);
  assert.equal(activities[1]?.detail, "npm test");
  assert.equal(activities[1]?.context, "1 test failed");
});
