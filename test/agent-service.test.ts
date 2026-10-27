import assert from "node:assert/strict";
import test from "node:test";
import { isolatedCodexEnvironment, orchestratorAuthorizations, parseAgentEnvelope, recommendedParallelism } from "../src/server/agent-service.js";

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
  const response = parseAgentEnvelope(`No user-facing update.\n<!-- qahwa-intake:{"ready":true} -->\n<!-- qahwa-silent -->\n<!-- qahwa-actions:[{"type":"start","taskId":"was-0001"},{"type":"message","taskId":"QAH-0002","message":"Check the failing test"},{"type":"interrupt","taskId":"MAJ-0003"},{"type":"priority","taskIds":["MAJ-0003","WAS-0001"]}] -->`);
  assert.equal(response.intakeReady, true);
  assert.equal(response.silent, true);
  assert.deepEqual(response.actions, [
    { type: "start", taskId: "WAS-0001" },
    { type: "message", taskId: "QAH-0002", message: "Check the failing test" },
    { type: "interrupt", taskId: "MAJ-0003" },
    { type: "priority", taskIds: ["MAJ-0003", "WAS-0001"] },
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

test("orchestrator recognizes contextual start authorization without authorizing system observations", () => {
  assert.equal(orchestratorAuthorizations("make the first one in your list only").start, true);
  assert.equal(orchestratorAuthorizations("go ahead").start, true);
  assert.equal(orchestratorAuthorizations("How would you handle them?").start, false);
  assert.deepEqual(orchestratorAuthorizations("start WAS-0004", false), { start: false, priority: false, control: false });
});
