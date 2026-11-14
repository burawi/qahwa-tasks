import assert from "node:assert/strict";
import test from "node:test";
import { coordinationFixture, until } from "./helpers/orchestrator-replies.js";
import { workspacePoll } from "../src/server/workspace-poll.js";
import { plainTextFromDocument } from "../src/domain/types.js";

const envelope = (body: string, actions: unknown[], silent = false) => `${body}\n<!-- qahwa-actions:${JSON.stringify(actions)} -->${silent ? "\n<!-- qahwa-silent -->" : ""}`;
const explanation = "The canvas failed because its document could not be loaded. I'll send the preview task the details so it can investigate.";
const authorization = "Send guidance and prioritize the canvas task";

test("successful task guidance preserves the authored explanation immediately and after persistence", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect the preview");
    f.settings({ delay: 150 });
    const itemId = await f.reply(envelope(explanation, [{ type: "message", taskId: task.humanId, message: "Check document loading", authorization }]));
    assert.equal(f.assistants().at(-1)?.body, explanation, "Explanation is visible while the action is in flight");
    await until(() => f.requests().some(({ method }) => method === "turn/steer"), "Guidance was not steered");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(f.assistants().length, 1);
    assert.equal(f.assistants()[0]?.body, explanation, "No duplicate success confirmation");
    const saved = f.database.db.prepare("SELECT body FROM chat_messages WHERE codex_item_id = ?").get(itemId) as { body: string };
    assert.equal(saved.body, explanation);
    assert.doesNotMatch(saved.body, /Guidance sent to|R\d+-\d+|qahwa-actions/);
  } finally { f.close(); }
});

test("partial failure keeps the explanation, adds the rejected action, and suppresses routine success", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    const first = f.task("Review saved documents", task.projectId);
    await f.reply(envelope(explanation, [
      { type: "priority", taskIds: [first.humanId], authorization },
      { type: "message", taskId: task.humanId, message: "Do unauthorized work", authorization: "not a user quote" },
    ]));
    await until(() => f.assistants()[0]?.body.includes("was not authorized") ?? false, "Rejection was not reported");
    const body = f.assistants()[0]!.body;
    assert.ok(body.startsWith(explanation));
    assert.match(body, /Update: I couldn't send guidance to “Fix the canvas preview”:.*was not authorized/);
    assert.doesNotMatch(body, /updated the task order|Guidance sent/);
    assert.equal(f.tasks.listTasks({ tab: "todo" })[0]?.id, first.id);
    assert.equal(f.agents.workspace("task", task.id).messages.length, 0);
    assert.equal(f.assistants().length, 1);
  } finally { f.close(); }
});

test("a failed task connection adds a visible correction to the same saved reply", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect the preview");
    f.settings({ reject: "turn/steer", delay: 150 });
    await f.reply(envelope(explanation, [{ type: "message", taskId: task.humanId, message: "Check document loading", authorization }]));
    const before = f.workspace();
    const cursor = workspacePoll(before, {});
    await until(() => f.assistants()[0]?.body.includes("connection was lost") ?? false, "Failure was not reported");
    const after = f.workspace();
    assert.equal(after.messages.at(-1)?.id, before.messages.at(-1)?.id);
    assert.ok(after.messages.at(-1)?.body.startsWith(explanation));
    assert.match(after.messages.at(-1)!.body, /Update: I couldn't send guidance to “Fix the canvas preview”: The task connection was lost/);
    const polled = workspacePoll(after, cursor);
    assert.notEqual(polled.messagesRevision, cursor.messagesRevision, "Polling delivers the added failure");
    assert.ok(polled.workspace && "messages" in polled.workspace);
  } finally { f.close(); }
});

test("action-only successes use descriptive task names without a generic Done reply", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect the preview");
    await f.reply(envelope("", [{ type: "message", taskId: task.humanId, message: "Check document loading", authorization }]));
    await until(() => f.assistants()[0]?.body.includes("I've sent") ?? false, "Action-only fallback was not acknowledged");
    assert.equal(f.assistants()[0]?.body, "I've sent your guidance to “Fix the canvas preview”.");
    assert.doesNotMatch(f.assistants()[0]!.body, /Done\.|R\d+-\d+/);
  } finally { f.close(); }
});

test("queued starts and guidance stay truthful under capacity and worktree serialization", async () => {
  for (const blocker of ["capacity", "worktree"] as const) {
    const f = coordinationFixture();
    try {
      const task = f.task();
      if (blocker === "capacity") f.agents.limit = 0;
      else {
        const running = f.task("Review saved documents", task.projectId);
        await f.agents.send("task", running.id, "Keep inspecting");
      }
      const body = "I'll arrange the canvas investigation and send it the loading error.";
      await f.reply(envelope(body, [
        { type: "start", taskId: task.humanId, authorization },
        { type: "message", taskId: task.humanId, message: "Check document loading", authorization },
      ]));
      await until(() => f.assistants()[0]?.body.includes("is queued") ?? false, `${blocker}: queue was not reported`);
      const saved = f.assistants()[0]!.body;
      assert.ok(saved.startsWith(body));
      assert.match(saved, /“Fix the canvas preview” is queued and will start when capacity and its worktree are available/);
      assert.match(saved, /guidance for “Fix the canvas preview” was saved for delivery. The receipt shows its current status/);
      assert.doesNotMatch(saved, /has started|sent your guidance|completed/);
      const workspace = f.agents.workspace("task", task.id);
      assert.equal(workspace.session.runState, "not_started");
      assert.ok(workspace.messages.at(-1)?.pending);
      assert.ok(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id = ?").get(task.id));
    } finally { f.close(); }
  }
});

test("action-only failures remain visible and use the task title", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.reply(envelope("", [{ type: "interrupt", taskId: task.humanId, authorization }]));
    await until(() => f.assistants().length === 1, "Failure fallback was not saved");
    assert.equal(f.assistants()[0]?.body, "I couldn't pause “Fix the canvas preview”: There is no active turn");
  } finally { f.close(); }
});

test("silent observations save no authored reply or action notice, including rejections", async () => {
  for (const authorized of [true, false]) {
    const f = coordinationFixture();
    try {
      const first = f.task("Review saved documents");
      const task = f.task("Fix the canvas preview", first.projectId);
      const quote = "Keep the canvas task first";
      f.database.setSetting("orchestrator_standing_directive", JSON.stringify({ id: "keep-first", instruction: quote, sourceQuote: quote, createdAt: new Date().toISOString() }));
      const actions = [{ type: "priority", taskIds: [task.humanId], authorization: quote, directiveId: authorized ? "keep-first" : "wrong-id" }];
      // An automated turn receives no user authorization; only the standing directive applies.
      await f.reply(envelope(explanation, actions, true), "Automated portfolio observation", "system");
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(f.assistants().length, 0);
      assert.equal((f.database.db.prepare("SELECT count(*) AS n FROM chat_messages WHERE role = 'assistant'").get() as { n: number }).n, 0);
      assert.equal(f.workspace().messages.length, 1);
      assert.equal(f.tasks.listTasks({ tab: "todo" })[0]?.id, authorized ? task.id : first.id);
    } finally { f.close(); }
  }
});

test("ordinary replies without actions and silent replies keep their existing behavior", async () => {
  for (const silent of [true, false]) {
    const f = coordinationFixture();
    try {
      await f.reply(silent ? "<!-- qahwa-silent -->" : "Here is what caused the preview to fail.");
      assert.deepEqual(f.assistants().map(({ body }) => body), silent ? [] : ["Here is what caused the preview to fail."]);
    } finally { f.close(); }
  }
});

test("direct orchestrator task creation is internal, structured, scoped, read-only, and starts mandatory intake", async () => {
  const f = coordinationFixture();
  try {
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const reviewer = f.agents.team.createMember({ name: "Jamil", title: "Product Designer", instructions: "Review UX evidence." });
    const userRequest = "Create and start a read-only Wassala admin UX audit";
    await f.reply(envelope("I’ll create the audit task and start its intake.", [{
      type: "create_task", idempotencyKey: "wassala-admin-ux-audit", projectId: project.id,
      title: "Audit Wassala Admin UX", goal: "Inspect the production UX from evidence",
      details: ["Capture mobile and desktop evidence", "Preserve operational behavior"],
      doneWhen: ["Jamil reviews the findings"], reviewerIds: [reviewer.id], accessMode: "read-only", startNow: true,
      authorization: userRequest,
    }]), userRequest);
    await until(() => f.tasks.listTasks({ tab: "all" }).length === 1, "Direct task was not created");
    const task = f.tasks.listTasks({ tab: "all" })[0]!;
    const orchestrator = f.workspace().session;
    f.emit([{ method: "turn/completed", params: { threadId: orchestrator.threadId,
      turn: { id: orchestrator.activeTurnId, status: "completed" } } }]);
    await until(() => Boolean(f.agents.workspace("task", task.id).session.activeTurnId), "Mandatory intake did not start");
    const detail = f.tasks.getTask(task.id);
    assert.equal(detail.projectId, project.id);
    const description = plainTextFromDocument(detail.description);
    assert.match(description, /Goal:\s*Inspect the production UX from evidence/);
    assert.match(description, /Capture mobile and desktop evidence/);
    assert.match(description, /Done when:\s*- Jamil reviews the findings/);
    assert.equal(f.agents.workspace("task", task.id).session.accessMode, "read-only");
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM orchestrator_task_creations").get() as { n: number }).n, 1);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM orchestrator_task_reviewers").get() as { n: number }).n, 1);
    const taskTurn = f.requests().find(request => request.method === "turn/start"
      && request.params.threadId === f.agents.workspace("task", task.id).session.threadId);
    assert.equal(taskTurn?.params.approvalPolicy, "never");
    assert.ok(!f.requests().some(request => request.method === "qahwa_tasks.create_tasks"));
  } finally { f.close(); }
});

test("direct task creation rejects non-current authorization", async () => {
  const f = coordinationFixture();
  try {
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const userRequest = "What would a Wassala audit involve?";
    await f.reply(envelope("I’ll keep this as a proposal.", [{
      type: "create_task", idempotencyKey: "unauthorized-audit", projectId: project.id,
      title: "Unauthorized audit", goal: "Do work", details: [], doneWhen: [], reviewerIds: [],
      accessMode: "read-only", startNow: false, authorization: "Create the task now",
    }]), userRequest);
    await until(() => f.assistants().at(-1)?.body.includes("exact quote from the current user request") ?? false, "Authorization rejection was not reported");
    assert.equal(f.tasks.listTasks({ tab: "all" }).length, 0);
  } finally { f.close(); }
});

test("direct task creation enforces active project scope", async () => {
  const f = coordinationFixture();
  try {
    await f.reply(envelope("I’ll validate the project target.", [{
      type: "create_task", idempotencyKey: "wrong-project", projectId: "missing-project",
      title: "Wrong project", goal: "Do work", details: [], doneWhen: [], reviewerIds: [],
      accessMode: "worktree-write", startNow: false, authorization: "Create this task",
    }]), "Create this task");
    await until(() => f.assistants().at(-1)?.body.includes("Active project not found") ?? false, "Project rejection was not reported");
    assert.equal(f.tasks.listTasks({ tab: "all" }).length, 0);
  } finally { f.close(); }
});

test("direct task creation is idempotent across replay and service restart", async () => {
  const f = coordinationFixture();
  try {
    f.agents.limit = 0;
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const authorization = "Create the Wassala redesign task";
    await f.agents.send("orchestrator", "main", authorization);
    const sourceMessageId = f.workspace().messages.find(message => message.role === "user")!.id;
    const action = { type: "create_task", idempotencyKey: "wassala-redesign", projectId: project.id,
      title: "Redesign Wassala Admin", goal: "Deliver the redesign", details: ["Preserve workflows"], doneWhen: ["Live verified"],
      reviewerIds: [], accessMode: "worktree-write", startNow: false, authorization };
    const apply = () => (f.agents as any).applyOrchestratorActions([action], authorization, null, "replayed-item", sourceMessageId);
    await apply();
    await apply();
    f.restart();
    f.agents.limit = 0;
    const replay = await apply();
    assert.match(replay[0].message, /already exists/);
    assert.equal(f.tasks.listTasks({ tab: "all" }).length, 1);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM orchestrator_task_creations").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("an applicable standing directive can authorize direct task creation without a user turn", async () => {
  const f = coordinationFixture();
  try {
    f.agents.limit = 0;
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const directive = { id: "deliver-wassala", instruction: "Create and run the authorized Wassala redesign work",
      sourceQuote: "Create and run the authorized Wassala redesign work", createdAt: new Date().toISOString() };
    f.database.setSetting("orchestrator_standing_directive", JSON.stringify(directive));
    await (f.agents as any).applyOrchestratorActions([{ type: "create_task", idempotencyKey: "directive-redesign", projectId: project.id,
      title: "Authorized redesign", goal: "Deliver the redesign", details: [], doneWhen: ["Verified live"], reviewerIds: [],
      accessMode: "worktree-write", startNow: true, authorization: directive.sourceQuote, directiveId: directive.id }],
    undefined, null, "directive-item", null);
    await until(() => f.tasks.listTasks({ tab: "all" }).length === 1, "Standing directive did not create the task");
    assert.equal((f.database.db.prepare("SELECT source_key FROM orchestrator_task_creations").get() as { source_key: string }).source_key,
      `directive:${directive.id}`);
  } finally { f.close(); }
});
