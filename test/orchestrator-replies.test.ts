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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
    } finally { await f.close(); }
  }
});

test("repeated action-only pauses report the already-stopped task truthfully", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.reply(envelope("", [{ type: "interrupt", taskId: task.humanId, authorization }]));
    await until(() => f.assistants().length === 1, "Pause outcome was not saved");
    assert.equal(f.assistants()[0]?.body, "I've paused “Fix the canvas preview”.");
  } finally { await f.close(); }
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
    } finally { await f.close(); }
  }
});

test("automated supervision can resume only an in-progress task with both a standing directive and an exact historical user quote", async () => {
  const f = coordinationFixture();
  try {
    f.agents.limit = 0;
    const quote = "Finish the Qahwa tasks, deploy them, then continue Wassala";
    (f.agents as any).addMessage("orchestrator", "main", "user", quote);
    f.database.setSetting("orchestrator_standing_directive", JSON.stringify({
      id: "supervise-active", instruction: "Actively supervise every already-authorized in-progress task",
      sourceQuote: "Keep authorized work moving", createdAt: new Date().toISOString(),
    }));
    const active = f.task("Consolidate the Qahwa release");
    f.tasks.transition(active.id, { to: "in_progress" }, "codex");
    const resumed = await (f.agents as any).applyOrchestratorActions([{
      type: "start", taskId: active.humanId, authorization: quote,
    }], undefined, null, "automated-resume", null);
    assert.equal(resumed.at(-1)?.status, "queued");
    assert.ok(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id=?").get(active.id));

    const guided = f.task("Validate the consolidated release", active.projectId);
    f.tasks.transition(guided.id, { to: "in_progress" }, "codex");
    const guidance = await (f.agents as any).applyOrchestratorActions([{
      type: "message", taskId: guided.humanId, message: "Run the authorized consolidated validation and release handoff", authorization: quote,
    }], undefined, null, "automated-guidance", null);
    assert.equal(guidance[0]?.status, "queued");
    assert.equal(f.agents.workspace("task", guided.id).messages.at(-1)?.pending, true);

    const unstarted = f.task("Unauthorized new work", active.projectId);
    const rejectedTodo = await (f.agents as any).applyOrchestratorActions([{
      type: "start", taskId: unstarted.humanId, authorization: quote,
    }], undefined, null, "automated-todo", null);
    assert.equal(rejectedTodo[0]?.status, "failed");
    assert.match(rejectedTodo[0]!.message, /not authorized/i);
    assert.equal(f.database.db.prepare("SELECT 1 FROM scheduler_queue WHERE task_id=?").get(unstarted.id), undefined);

    f.database.deleteSetting("orchestrator_standing_directive");
    const noDirective = f.task("Inactive supervision", active.projectId);
    f.tasks.transition(noDirective.id, { to: "in_progress" }, "codex");
    const rejectedWithoutDirective = await (f.agents as any).applyOrchestratorActions([{
      type: "start", taskId: noDirective.humanId, authorization: quote,
    }], undefined, null, "automated-no-directive", null);
    assert.equal(rejectedWithoutDirective[0]?.status, "failed");
    assert.match(rejectedWithoutDirective[0]!.message, /not authorized/i);
  } finally { await f.close(); }
});

test("an overloaded main orchestrator rolls into a fresh thread without losing history or its standing directive", async () => {
  const f = coordinationFixture();
  try {
    const quote = "Finish the Qahwa tasks, deploy them, then continue Wassala";
    f.database.setSetting("orchestrator_standing_directive", JSON.stringify({
      id: "keep-moving", instruction: "Keep authorized in-progress work moving",
      sourceQuote: "Do not leave authorized work idle", createdAt: new Date().toISOString(),
    }));
    await f.agents.send("orchestrator", "main", quote);
    const before = f.workspace().session;
    assert.ok(before.threadId && before.activeTurnId);
    f.emit([
      { method: "thread/tokenUsage/updated", params: { threadId: before.threadId, turnId: before.activeTurnId,
        tokenUsage: { total: { totalTokens: 1_000_000 }, last: { totalTokens: 80_000 }, modelContextWindow: 100_000 } } },
      { method: "turn/completed", params: { threadId: before.threadId,
        turn: { id: before.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.workspace().session.generation === before.generation + 1, "Main orchestrator context did not roll over");
    assert.equal(f.database.setting("orchestrator_standing_directive")?.includes("keep-moving"), true);
    assert.equal(f.workspace().messages.some(message => message.role === "user" && message.body === quote), true);
    assert.equal(f.workspace().messages.some(message => message.metadata?.contextRollover === true), true);
    await until(() => f.requests().filter(request => request.method === "thread/start").length >= 2,
      "Rollover observation did not start a fresh orchestrator thread");
    const starts = f.requests().filter(request => request.method === "thread/start");
    assert.ok(f.workspace().session.threadId && f.workspace().session.threadId !== before.threadId);
    assert.equal(f.requests().some(request => request.method === "thread/archive" && request.params.threadId === before.threadId), true);
    const freshTurn = f.requests().filter(request => request.method === "turn/start").at(-1)!;
    assert.match(String(freshTurn.params.input[0].text), new RegExp(quote));
    assert.equal(starts.length, 2);
  } finally { await f.close(); }
});

test("ordinary replies without actions and silent replies keep their existing behavior", async () => {
  for (const silent of [true, false]) {
    const f = coordinationFixture();
    try {
      await f.reply(silent ? "<!-- qahwa-silent -->" : "Here is what caused the preview to fail.");
      assert.deepEqual(f.assistants().map(({ body }) => body), silent ? [] : ["Here is what caused the preview to fail."]);
    } finally { await f.close(); }
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
    const review = f.database.db.prepare("SELECT id,member_id,snapshot_name,snapshot_title,status FROM orchestrator_task_reviewers").get() as any;
    assert.equal(review.member_id, reviewer.id);
    assert.equal(review.snapshot_name, "Jamil");
    assert.equal(review.snapshot_title, "Product Designer");
    const taskTurn = f.requests().find(request => request.method === "turn/start"
      && request.params.threadId === f.agents.workspace("task", task.id).session.threadId);
    assert.equal(taskTurn?.params.approvalPolicy, "never");
    const taskThread = f.requests().find(request => request.method === "thread/start"
      && String(request.params.developerInstructions).includes(`persistent Codex session for ${task.humanId}`));
    const initialContext = String(taskThread?.params.developerInstructions);
    assert.match(initialContext, /REGISTERED SPECIALIST REVIEWERS/);
    assert.match(initialContext, new RegExp(review.id));
    assert.match(initialContext, new RegExp(reviewer.id));
    assert.match(initialContext, /"snapshotName":"Jamil"/);
    assert.match(initialContext, /"snapshotTitle":"Product Designer"/);
    assert.match(initialContext, /real Qahwa supervisory Codex member sessions/);
    assert.match(initialContext, /never ask the user who they are/i);
    assert.match(initialContext, /No completed intake handoff is recorded yet/);
    assert.ok(!f.requests().some(request => request.method === "qahwa_tasks.create_tasks"));
  } finally { await f.close(); }
});

test("reviewer and resolved-intake context survives access handoff, restart resume, and a fresh recovery thread", async () => {
  const f = coordinationFixture();
  try {
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const reviewer = f.agents.team.createMember({ name: "Jamil", title: "Product Designer", instructions: "Review UX evidence." });
    const authorization = "Create and start the Wassala redesign with Jamil review";
    await f.reply(envelope("I’ll start the redesign intake.", [{
      type: "create_task", idempotencyKey: "review-context-lifecycle", projectId: project.id,
      title: "Redesign Wassala Admin", goal: "Deliver a coherent admin redesign",
      details: ["French and Arabic are required"], doneWhen: ["Jamil reviews concrete evidence"],
      reviewerIds: [reviewer.id], accessMode: "worktree-write", startNow: true, authorization,
    }]), authorization);
    await until(() => f.tasks.listTasks({ tab: "all" }).length === 1, "Task was not created");
    const task = f.tasks.listTasks({ tab: "all" })[0]!;
    const orchestrator = f.workspace().session;
    f.emit([{ method: "turn/completed", params: { threadId: orchestrator.threadId,
      turn: { id: orchestrator.activeTurnId, status: "completed" } } }]);
    await until(() => Boolean(f.agents.workspace("task", task.id).session.activeTurnId), "Intake did not start");
    const intake = f.agents.workspace("task", task.id).session;
    await (f.agents as any).messageTask(task.id, "Keep the resolved information architecture and do not ask the user to restate it", null, "resolved-guidance");
    f.emit([
      { method: "item/completed", params: { threadId: intake.threadId, turnId: intake.activeTurnId,
        item: { id: "resolved-intake", type: "agentMessage", phase: "final_answer",
          text: `Resolved contracts: keep English compatibility, add French and complete Arabic RTL; no further product decision is missing.\n<!-- qahwa-intake:{"ready":true,"accessMode":"worktree-write"} -->` } } },
      { method: "turn/completed", params: { threadId: intake.threadId, turn: { id: intake.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.agents.workspace("task", task.id).session.threadId !== intake.threadId
      && Boolean(f.agents.workspace("task", task.id).session.activeTurnId), "Implementation thread did not start");
    let implementation = f.agents.workspace("task", task.id).session;
    const implementationStart = f.requests().filter(request => request.method === "thread/start"
      && request.params.cwd === f.root).at(-1)!;
    const implementationContext = String(implementationStart.params.developerInstructions);
    assert.match(implementationContext, /Resolved contracts: keep English compatibility/);
    assert.match(implementationContext, /Keep the resolved information architecture/);
    assert.match(implementationContext, /"requestedAccessMode":"worktree-write"/);
    assert.match(implementationContext, /REGISTERED SPECIALIST REVIEWERS/);
    assert.match(implementationContext, /Historical questions in transcripts are not open blockers/);
    const implementationTurn = f.requests().filter(request => request.method === "turn/start"
      && request.params.threadId === implementation.threadId).at(-1)!;
    assert.match(String(implementationTurn.params.input[0].text), /IMMUTABLE USER\/TASK SCOPE/);
    assert.match(String(implementationTurn.params.input[0].text), /authoritative resolved-intake handoff is supplied separately/);

    f.emit([{ method: "turn/completed", params: { threadId: implementation.threadId,
      turn: { id: implementation.activeTurnId, status: "completed" } } }]);
    await until(() => f.agents.workspace("task", task.id).session.runState === "idle", "Implementation turn did not settle");
    await f.restart();
    await f.agents.send("task", task.id, "Continue with the resolved implementation contracts");
    implementation = f.agents.workspace("task", task.id).session;
    const resumed = f.requests().filter(request => request.method === "thread/resume"
      && request.params.threadId === implementation.threadId).at(-1)!;
    assert.match(String(resumed.params.developerInstructions), /Resolved contracts: keep English compatibility/);
    assert.match(String(resumed.params.developerInstructions), new RegExp(reviewer.id));

    f.emit([{ method: "turn/completed", params: { threadId: implementation.threadId,
      turn: { id: implementation.activeTurnId, status: "completed" } } }]);
    await until(() => f.agents.workspace("task", task.id).session.runState === "idle", "Resumed turn did not settle");
    f.agents.team.updateMember(reviewer.id, { name: "Jamil Design", title: "Design Manager" });
    f.database.db.prepare(`UPDATE agent_sessions SET thread_id=NULL,active_turn_id=NULL,run_state='idle',generation=generation+1
      WHERE owner_type='task' AND owner_id=?`).run(task.id);
    await f.agents.send("task", task.id, "Continue in a fresh recovered context");
    const recovered = f.agents.workspace("task", task.id).session;
    const freshStart = f.requests().filter(request => request.method === "thread/start"
      && request.params.cwd === f.root).at(-1)!;
    const freshContext = String(freshStart.params.developerInstructions);
    assert.match(freshContext, /Resolved contracts: keep English compatibility/);
    assert.match(freshContext, /"snapshotName":"Jamil"/);
    assert.match(freshContext, /"snapshotTitle":"Product Designer"/);
    assert.match(freshContext, /"currentName":"Jamil Design"/);
    assert.match(freshContext, /"currentTitle":"Design Manager"/);
    assert.ok(recovered.threadId && recovered.threadId !== implementation.threadId);
    f.agents.team.archiveMember(reviewer.id);
    const archivedContext = String((f.agents as any).taskTurnContext(task.id));
    assert.match(archivedContext, /"snapshotName":"Jamil"/);
    assert.match(archivedContext, /"snapshotTitle":"Product Designer"/);
    assert.match(archivedContext, /"currentName":null/);
    assert.match(archivedContext, /"currentTitle":null/);
    assert.match(archivedContext, /"routable":false/);
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
    await f.restart();
    f.agents.limit = 0;
    const replay = await apply();
    assert.match(replay[0].message, /already exists/);
    assert.equal(f.tasks.listTasks({ tab: "all" }).length, 1);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM orchestrator_task_creations").get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test("unsorted legacy reviewer replay returns the existing task without mutating its record", async () => {
  const f = coordinationFixture();
  try {
    f.agents.limit = 0;
    const project = f.tasks.createProject({ name: "Legacy", prefix: "LEG", rootDirectory: f.root }, "user");
    const members = ["Nathem", "Mohsin"].map((name, index) => f.agents.team.createMember({
      name, title: index ? "Product Manager" : "Technical Lead", instructions: "Review only",
    }));
    const sortedReviewerIds = members.map(member => member.id).sort();
    const unsortedReviewerIds = [...sortedReviewerIds].reverse();
    const authorization = "Create the legacy reviewed task";
    await f.agents.send("orchestrator", "main", authorization);
    const sourceMessageId = f.workspace().messages.find(message => message.role === "user")!.id;
    const base = { type: "create_task", idempotencyKey: "legacy-review-order", projectId: project.id,
      title: "Legacy reviewed task", goal: "Preserve legacy replay", details: ["No record mutation"], doneWhen: ["Replay is idempotent"],
      accessMode: "worktree-write", startNow: false, authorization };
    await (f.agents as any).applyOrchestratorActions([{ ...base, reviewerIds: sortedReviewerIds }],
      authorization, null, "legacy-seed", sourceMessageId);
    f.database.db.prepare("UPDATE orchestrator_task_creations SET review_policy='legacy_parallel'").run();
    const task = f.tasks.listTasks({ tab: "all" })[0]!;
    const beforeCreation = f.database.db.prepare("SELECT * FROM orchestrator_task_creations WHERE task_id=?").get(task.id);
    const beforeReviewers = f.database.db.prepare(`SELECT id,member_id,position,status,created_at,updated_at
      FROM orchestrator_task_reviewers ORDER BY position,rowid`).all();

    await f.restart();
    f.agents.limit = 0;
    const replay = await (f.agents as any).applyOrchestratorActions([{ ...base, reviewerIds: unsortedReviewerIds }],
      authorization, null, "legacy-replay", sourceMessageId);
    assert.match(replay[0]!.message, /already exists/);
    assert.equal(f.tasks.listTasks({ tab: "all" }).length, 1);
    assert.deepEqual(f.database.db.prepare("SELECT * FROM orchestrator_task_creations WHERE task_id=?").get(task.id), beforeCreation);
    assert.deepEqual(f.database.db.prepare(`SELECT id,member_id,position,status,created_at,updated_at
      FROM orchestrator_task_reviewers ORDER BY position,rowid`).all(), beforeReviewers);
  } finally { await f.close(); }
});

test("reordered sequential reviewer replay remains an idempotency conflict", async () => {
  const f = coordinationFixture();
  try {
    f.agents.limit = 0;
    const project = f.tasks.createProject({ name: "Sequential", prefix: "SEQ", rootDirectory: f.root }, "user");
    const members = ["Nathem", "Mohsin"].map((name, index) => f.agents.team.createMember({
      name, title: index ? "Product Manager" : "Technical Lead", instructions: "Review only",
    }));
    const sortedReviewerIds = members.map(member => member.id).sort();
    const configuredReviewerIds = [...sortedReviewerIds].reverse();
    const authorization = "Create the sequential reviewed task";
    await f.agents.send("orchestrator", "main", authorization);
    const sourceMessageId = f.workspace().messages.find(message => message.role === "user")!.id;
    const base = { type: "create_task", idempotencyKey: "sequential-review-order", projectId: project.id,
      title: "Sequential reviewed task", goal: "Keep reviewer order significant", details: [], doneWhen: ["Reordering conflicts"],
      accessMode: "worktree-write", startNow: false, authorization };
    await (f.agents as any).applyOrchestratorActions([{ ...base, reviewerIds: configuredReviewerIds }],
      authorization, null, "sequential-seed", sourceMessageId);
    const task = f.tasks.listTasks({ tab: "all" })[0]!;
    const before = f.database.db.prepare("SELECT * FROM orchestrator_task_creations WHERE task_id=?").get(task.id);

    await f.restart();
    f.agents.limit = 0;
    const replay = await (f.agents as any).applyOrchestratorActions([{ ...base, reviewerIds: sortedReviewerIds }],
      authorization, null, "sequential-replay", sourceMessageId);
    assert.equal(replay[0]!.status, "failed");
    assert.match(replay[0]!.message, /already used for different work/);
    assert.equal(f.tasks.listTasks({ tab: "all" }).length, 1);
    assert.deepEqual(f.database.db.prepare("SELECT * FROM orchestrator_task_creations WHERE task_id=?").get(task.id), before);
  } finally { await f.close(); }
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
  } finally { await f.close(); }
});
