import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { memberSessionOwnerId } from "../src/server/team-service.js";
import { coordinationFixture, until } from "./helpers/orchestrator-replies.js";

async function reviewedTask(f: ReturnType<typeof coordinationFixture>, names: string[]) {
  const project = f.tasks.createProject({ name: "Qahwa", prefix: `WF${names.length}`, rootDirectory: f.root }, "user");
  const members = names.map((name, index) => f.agents.team.createMember({
    name, title: ["Technical Lead", "Product Manager", "QA Manager"][index] ?? "Specialist",
    instructions: "Review task evidence without performing implementation.",
  }));
  const authorization = `Create the workflow task with ${names.join(", ")} reviewing in that order`;
  await f.agents.send("orchestrator", "main", authorization);
  const sourceMessageId = f.agents.workspace("orchestrator", "main").messages.find(message => message.role === "user")!.id;
  await (f.agents as any).applyOrchestratorActions([{
    type: "create_task", idempotencyKey: `workflow-${names.join("-").toLowerCase()}`,
    projectId: project.id, title: "Automate the review workflow", goal: "Deliver validated workflow evidence",
    details: ["Preserve immutable scope and authorization"], doneWhen: ["Configured specialists review in order"],
    reviewerIds: members.map(member => member.id), accessMode: "worktree-write", startNow: false, authorization,
  }], authorization, null, "create-workflow", sourceMessageId);
  const task = f.tasks.listTasks({ tab: "all" })[0]!;
  f.tasks.transition(task.id, { to: "in_progress" }, "codex");
  f.tasks.submitForReview(task.id, { summary: "Validated workflow evidence", validation: ["Focused tests passed"] }, "codex");
  return { task, members, authorization };
}

function reviews(f: ReturnType<typeof coordinationFixture>) {
  return f.database.db.prepare("SELECT * FROM orchestrator_task_reviewers ORDER BY position,rowid").all() as any[];
}

async function emitReview(f: ReturnType<typeof coordinationFixture>, memberId: string, taskId: string,
  itemId: string, marker: Record<string, string>) {
  const memberSession = f.agents.team.ensureTaskSession(memberId, taskId);
  const ownerId = memberSessionOwnerId(memberSession.id);
  await until(() => Boolean(f.agents.workspace("orchestrator", ownerId).session.activeTurnId), `${itemId} did not start`);
  const session = f.agents.workspace("orchestrator", ownerId).session;
  f.emit([
    { method: "item/completed", params: { threadId: session.threadId, turnId: session.activeTurnId,
      item: { id: itemId, type: "agentMessage", phase: "final_answer",
        text: `Specialist verdict.\n<!-- qahwa-management-review:${JSON.stringify(marker)} -->` } } },
    { method: "turn/completed", params: { threadId: session.threadId,
      turn: { id: session.activeTurnId, status: "completed" } } },
  ]);
}

type DirectReviewCrashCut = "after_trace" | "after_dispatch" | "after_prompt" | "after_pending";

async function assertDirectReviewCrashCut(stage: DirectReviewCrashCut) {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem"]);
    const review = reviews(f)[0]!;
    const member = first.members[0]!;
    f.agents.limit = 0;
    f.database.db.prepare("UPDATE orchestrator_task_reviewers SET status='awaiting_review',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), review.id);
    const traceId = (f.agents as any).addMessage("task", first.task.id, "system",
      `${member.name} (${member.title}) is reviewing this result.`, { specialistReview: review.id, memberId: member.id });
    const participant = f.agents.team.participant(member);
    let dispatchId: string | null = null;
    if (stage !== "after_trace") dispatchId = f.agents.team.createDispatch(traceId, "task", first.task.id, participant);
    if (stage === "after_prompt" || stage === "after_pending") {
      const memberSession = f.agents.team.ensureTaskSession(member.id, first.task.id);
      const ownerId = memberSessionOwnerId(memberSession.id);
      const promptId = (f.agents as any).addMessage("orchestrator", ownerId, "system",
        "Crash-cut direct review instruction", {
          teamDispatchId: dispatchId, responseTarget: { type: "direct_review", id: review.id },
          participantType: participant.type, participantId: participant.id,
          participantName: participant.name, participantTitle: participant.title,
          participantAvatar: participant.avatar, interactionTrace: true,
        });
      if (stage === "after_pending") f.database.db.prepare(`INSERT INTO pending_messages(message_id,dispatch_order)
        VALUES (?,(SELECT COALESCE(MAX(dispatch_order),0)+1 FROM pending_messages))`).run(promptId);
    }

    const snapshot = () => ({
      reviewerStatus: reviews(f)[0]!.status,
      traceCount: Number((f.database.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages
        WHERE owner_type='task' AND owner_id=?
          AND json_extract(metadata_json,'$.specialistReview')=?`).get(first.task.id, review.id) as any).n),
      effectiveTraceCount: Number((f.database.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages
        WHERE owner_type='task' AND owner_id=? AND cancelled_at IS NULL
          AND json_extract(metadata_json,'$.specialistReview')=?`).get(first.task.id, review.id) as any).n),
      promptCount: Number((f.database.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages
        WHERE json_extract(metadata_json,'$.responseTarget.type')='direct_review'
          AND json_extract(metadata_json,'$.responseTarget.id')=?`).get(review.id) as any).n),
      effectivePromptCount: Number((f.database.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages
        WHERE json_extract(metadata_json,'$.responseTarget.type')='direct_review'
          AND json_extract(metadata_json,'$.responseTarget.id')=? AND cancelled_at IS NULL`).get(review.id) as any).n),
      pendingPromptCount: Number((f.database.db.prepare(`SELECT COUNT(*) AS n FROM pending_messages pm
        JOIN chat_messages cm ON cm.id=pm.message_id
        WHERE json_extract(cm.metadata_json,'$.responseTarget.type')='direct_review'
          AND json_extract(cm.metadata_json,'$.responseTarget.id')=?`).get(review.id) as any).n),
      dispatchCount: Number((f.database.db.prepare(`SELECT COUNT(*) AS n FROM team_dispatches
        WHERE source_type='task' AND source_id=? AND participant_id=?`).get(first.task.id, member.id) as any).n),
      effectiveDispatchCount: Number((f.database.db.prepare(`SELECT COUNT(*) AS n FROM team_dispatches
        WHERE source_type='task' AND source_id=? AND participant_id=? AND status!='failed'`)
        .get(first.task.id, member.id) as any).n),
    });

    await f.restart();
    f.agents.limit = 0;
    await (f.agents as any).resumeQueues();
    const recovered = snapshot();
    assert.equal(recovered.reviewerStatus, "awaiting_review");
    assert.equal(recovered.effectiveTraceCount, 1, "Recovery must leave one effective visible task review trace");
    assert.equal(recovered.effectivePromptCount, 1, "Recovery must leave one effective specialist instruction");
    assert.equal(recovered.pendingPromptCount, 1, "Recovery must leave one durable queued specialist instruction");
    assert.equal(recovered.effectiveDispatchCount, 1, "Recovery must leave one effective specialist dispatch");
    assert.equal(recovered.traceCount, stage === "after_pending" ? 1 : 2,
      "A pre-queue trace is cancelled on requeue, while a durably queued trace is reused");
    assert.equal(recovered.promptCount, stage === "after_prompt" ? 2 : 1,
      "An orphan prompt is cancelled and replaced, while an already queued prompt is reused");
    assert.equal(recovered.dispatchCount, stage === "after_dispatch" || stage === "after_prompt" ? 2 : 1,
      "An orphan dispatch is failed and replaced, while an already queued dispatch is reused");

    await f.restart();
    f.agents.limit = 0;
    await (f.agents as any).resumeQueues();
    assert.deepEqual(snapshot(), recovered, "Repeated restarts must not duplicate prompts or effective dispatches");
  } finally { await f.close(); }
}

test("direct reviews dispatch sequentially, expose capacity ownership, and advance through every approval", async () => {
  const f = coordinationFixture();
  try {
    const { task, members } = await reviewedTask(f, ["Nathem", "Mohsin", "Faysal"]);
    f.agents.limit = 0;
    await (f.agents as any).queueDirectTaskReviews(task.id, "Validated workflow evidence");
    assert.deepEqual(reviews(f).map(review => review.status), ["awaiting_review", "pending", "pending"]);
    let workflow = f.tasks.getTask(task.id).workflow!;
    assert.equal(workflow.state, "capacity_queued");
    assert.equal(workflow.ownerActive, undefined);
    assert.match(workflow.owner, /Nathem/);
    assert.match(workflow.nextAction, /capacity/i);

    f.agents.limit = 4;
    await (f.agents as any).resumeQueues();
    await until(() => f.tasks.getTask(task.id).workflow?.state === "reviewing", "Active specialist owner was not projected");
    assert.equal(f.tasks.getTask(task.id).workflow?.ownerActive, true);
    await emitReview(f, members[0]!.id, task.id, "nathem-approval", { decision: "approved", feedback: "Technical evidence is sound" });
    await until(() => reviews(f)[0]!.status === "approved" && reviews(f)[1]!.status === "awaiting_review",
      "Mohsin did not follow Nathem");
    assert.equal(reviews(f)[2]!.status, "pending");

    await emitReview(f, members[1]!.id, task.id, "mohsin-approval", { decision: "approved", feedback: "Product outcome is complete" });
    await until(() => reviews(f)[1]!.status === "approved" && reviews(f)[2]!.status === "awaiting_review",
      "Faysal did not follow Mohsin");
    await emitReview(f, members[2]!.id, task.id, "faysal-approval", { decision: "approved", feedback: "QA evidence passes" });
    await until(() => reviews(f).every(review => review.status === "approved"), "Final approval was not durable");
    workflow = f.tasks.getTask(task.id).workflow!;
    assert.equal(workflow.state, "ready_for_review");
    assert.equal(workflow.owner, "You");
    assert.match(workflow.nextAction, /explicit gates/);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM team_dispatches WHERE source_type='task'").get() as any).n, 3);
    f.database.db.prepare("UPDATE orchestrator_task_reviewers SET status='failed',latest_feedback='Reviewer session unavailable' WHERE position=2").run();
    workflow = f.tasks.getTask(task.id).workflow!;
    assert.equal(workflow.state, "blocked");
    assert.match(workflow.owner, /Faysal/);
    assert.equal(workflow.blocker, "Reviewer session unavailable");
  } finally { await f.close(); }
});

test("in-scope corrections resume automatically once, preserve full feedback, and survive restart replay", async () => {
  const f = coordinationFixture();
  try {
    const { task, members } = await reviewedTask(f, ["Nathem"]);
    await (f.agents as any).queueDirectTaskReviews(task.id, "Initial evidence");
    await emitReview(f, members[0]!.id, task.id, "scoped-corrections", {
      decision: "changes_requested", feedback: "Keep immutable scope; add the missing restart and duplicate-delivery assertions.",
    });
    await until(() => reviews(f)[0]!.status === "pending" && reviews(f)[0]!.feedback_delivery_status === "delivered",
      "Corrections were not routed automatically");
    const messages = () => f.agents.workspace("task", task.id).messages.filter(message => message.body.includes("missing restart and duplicate-delivery assertions"));
    assert.equal(messages().length, 1);
    assert.match(messages()[0]!.body, /Nathem \(Technical Lead\)/);
    assert.match(messages()[0]!.body, /Apply only these exact scoped corrections/);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM guidance_deliveries WHERE action_key LIKE 'direct-review-feedback:%'").get() as any).n, 1);

    await f.restart();
    await (f.agents as any).resumeQueues();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(messages().length, 1, "Restart recovery must not duplicate complete reviewer feedback");
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM guidance_deliveries WHERE action_key LIKE 'direct-review-feedback:%'").get() as any).n, 1);
  } finally { await f.close(); }
});

test("restart cancels and replaces a direct-review orphan created before pending insertion exactly once", async () => {
  await assertDirectReviewCrashCut("after_prompt");
});

test("restart reuses a direct-review prompt durable after pending insertion across repeated restarts", async () => {
  await assertDirectReviewCrashCut("after_pending");
});

test("restart cancels an orphan review trace created before dispatch and leaves one effective trace", async () => {
  await assertDirectReviewCrashCut("after_trace");
});

test("restart fails a dispatch created before its prompt and leaves one effective dispatch", async () => {
  await assertDirectReviewCrashCut("after_dispatch");
});

test("a registered review verdict delivered through task advice still advances the durable workflow", async () => {
  const f = coordinationFixture();
  try {
    const { task, members } = await reviewedTask(f, ["Nathem"]);
    await (f.agents as any).consultMember(members[0]!.id, task.id, "Review the current result and return your verdict", null);
    await (f.agents as any).drainPendingMessages();
    await emitReview(f, members[0]!.id, task.id, "misrouted-live-review", {
      decision: "changes_requested", feedback: "Add the missing rendered mobile evidence.",
    });
    await until(() => reviews(f)[0]!.status === "pending" && reviews(f)[0]!.feedback_delivery_status === "delivered",
      "The task-target verdict did not resume the durable correction workflow");
    assert.equal(reviews(f)[0]!.review_count, 1);
    assert.equal(reviews(f)[0]!.latest_feedback, "Add the missing rendered mobile evidence.");
    assert.equal((f.database.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages
      WHERE json_extract(metadata_json,'$.specialistReview')=?`).get(reviews(f)[0]!.id) as any).n, 1);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM guidance_deliveries WHERE action_key LIKE 'direct-review-feedback:%'").get() as any).n, 1);
  } finally { await f.close(); }
});

test("restart recovers the newest explicit registered verdict that an older server treated as task advice", async () => {
  const f = coordinationFixture();
  try {
    const { task, members } = await reviewedTask(f, ["Nathem"]);
    await (f.agents as any).consultMember(members[0]!.id, task.id, "Review the current result and return your verdict", null);
    await (f.agents as any).drainPendingMessages();
    const dispatch = f.database.db.prepare(`SELECT * FROM team_dispatches WHERE participant_id=? ORDER BY created_at DESC LIMIT 1`)
      .get(members[0]!.id) as any;
    const prompt = f.database.db.prepare(`SELECT * FROM chat_messages
      WHERE json_extract(metadata_json,'$.teamDispatchId')=? ORDER BY rowid DESC LIMIT 1`).get(dispatch.id) as any;
    const session = f.agents.workspace("orchestrator", prompt.owner_id).session;
    const raw = `Recovered verdict.\n<!-- qahwa-management-review:{"decision":"changes_requested","feedback":"Preserve and route this recovered correction exactly once."} -->`;
    const eventAt = new Date().toISOString();
    f.database.db.prepare(`INSERT INTO session_events(owner_type,owner_id,thread_id,turn_id,event_type,payload_json,created_at)
      VALUES ('orchestrator',?,?,?,'item/completed',?,?)`).run(prompt.owner_id, session.threadId, session.activeTurnId,
        JSON.stringify({ payload: { item: { type: "agentMessage", phase: "final_answer", text: raw } } }), eventAt);
    const responseId = (f.agents as any).addMessage("task", task.id, "assistant", "Recovered verdict.", {
      speaker: { type: "member", id: members[0]!.id, name: "Nathem", title: "Technical Lead" },
      teamDispatchId: dispatch.id, originatingInteraction: prompt.id,
    });
    f.agents.team.completeDispatch(dispatch.id, responseId);

    await f.restart();
    await (f.agents as any).resumeQueues();
    await until(() => reviews(f)[0]!.status === "pending" && reviews(f)[0]!.feedback_delivery_status === "delivered",
      "Restart did not recover and route the explicit verdict");
    assert.equal(reviews(f)[0]!.review_count, 1);
    assert.equal(reviews(f)[0]!.latest_feedback, "Preserve and route this recovered correction exactly once.");
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM guidance_deliveries WHERE action_key LIKE 'direct-review-feedback:%'").get() as any).n, 1);

    await f.restart();
    await (f.agents as any).resumeQueues();
    assert.equal(reviews(f)[0]!.review_count, 1);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM guidance_deliveries WHERE action_key LIKE 'direct-review-feedback:%'").get() as any).n, 1,
      "Recovered reviews must remain idempotent across later restarts");
  } finally { await f.close(); }
});

test("new authority requires a fresh current-user quote and survives the full re-review cycle", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem", "Mohsin"]);
    await (f.agents as any).queueDirectTaskReviews(first.task.id, "Product evidence");
    await emitReview(f, first.members[0]!.id, first.task.id, "authority-needed", {
      decision: "waiting_for_user", feedback: "Add an unrelated billing dashboard redesign.",
      decisionRequired: "Authorize or reject the billing dashboard redesign", responsibleOwner: "Product owner",
    });
    await until(() => reviews(f)[0]!.status === "waiting_for_user", "Authority boundary was not retained");
    const waiting = reviews(f)[0]!;
    assert.equal(waiting.feedback_kind, "authority_required");
    assert.equal(waiting.latest_feedback, "Add an unrelated billing dashboard redesign.");
    assert.equal(waiting.decision_required, "Authorize or reject the billing dashboard redesign");
    assert.equal(waiting.responsible_owner, "Product owner");
    assert.equal(f.tasks.getTask(first.task.id).workflow?.state, "waiting_for_user");
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM guidance_deliveries").get() as any).n, 0,
      "Newly authorized work must not resume silently");

    await f.restart();
    await (f.agents as any).resumeQueues();
    assert.equal(reviews(f)[0]!.status, "waiting_for_user");

    const stale = await (f.agents as any).applyOrchestratorActions([{
      type: "task_review_resolution", reviewId: waiting.id, resolution: "authorize",
      message: "Treat the old task request as approval", authorization: first.authorization,
    }], "Show me the current task status", null, "stale-authority", null);
    assert.equal(stale[0]!.status, "failed");
    assert.match(stale[0]!.message, /exact quote from the current user message/i);
    assert.equal(reviews(f)[0]!.status, "waiting_for_user");
    assert.equal(reviews(f)[0]!.resolution_authorization_text, null);

    const authorization = "Authorize the billing dashboard redesign for this task only";
    await (f.agents as any).applyOrchestratorActions([{
      type: "task_review_resolution", reviewId: waiting.id, resolution: "authorize", message: authorization, authorization,
    }], authorization, null, "authorize-extra-scope", null);
    await until(() => reviews(f)[0]!.status === "pending" && reviews(f)[0]!.feedback_delivery_status === "delivered",
      "The explicit user authorization was not delivered");
    assert.equal(reviews(f)[0]!.resolution_status, "authorized");
    assert.equal(reviews(f)[0]!.resolution_text, authorization);
    assert.equal(reviews(f)[0]!.resolution_authorization_text, authorization);
    assert.ok(f.agents.workspace("task", first.task.id).messages.some(message => message.body.includes(`Later user authorization: ${authorization}`)));

    await until(() => f.tasks.getTask(first.task.id).status === "in_progress", "Authorized correction turn did not resume");
    f.tasks.submitForReview(first.task.id, { summary: "Authorized dashboard evidence", validation: ["Focused dashboard review passed"] }, "codex");
    const taskSession = f.agents.workspace("task", first.task.id).session;
    f.emit([{ method: "turn/completed", params: { threadId: taskSession.threadId,
      turn: { id: taskSession.activeTurnId, status: "completed" } } }]);
    await until(() => f.agents.workspace("task", first.task.id).session.runState === "idle", "Correction turn did not finish");
    const specialistPrompts = () => f.requests().filter(request => request.method === "turn/start")
      .map(request => request.params.input[0].text as string).filter(text => text.includes(`Review task ${first.task.humanId}`));
    await until(() => specialistPrompts().some(prompt => prompt.includes(`Later user authorization (exact stored quote): ${authorization}`)),
      "The authorized re-review prompt was not queued");
    const promptsBeforeRestart = specialistPrompts().length;
    await f.restart();
    await (f.agents as any).resumeQueues();
    assert.equal(reviews(f)[0]!.resolution_authorization_text, authorization,
      "The exact later authorization must survive restart recovery");
    await until(() => reviews(f)[0]!.status === "awaiting_review", "Nathem re-review did not start");
    await until(() => specialistPrompts().length > promptsBeforeRestart, "Interrupted re-review was not recovered after restart");
    const nathemPrompt = specialistPrompts().at(-1)!;
    assert.match(nathemPrompt, new RegExp(`Later user authorization.*${authorization}`));
    await emitReview(f, first.members[0]!.id, first.task.id, "authorized-approval", {
      decision: "approved", feedback: "The newly authorized correction is complete.",
    });
    await until(() => reviews(f)[0]!.status === "approved" && reviews(f)[1]!.status === "awaiting_review",
      "Approval did not advance to the next configured reviewer");
    const mohsinPrompt = f.requests().filter(request => request.method === "turn/start")
      .map(request => request.params.input[0].text as string).filter(text => text.includes(`Review task ${first.task.humanId}`)).at(-1)!;
    assert.match(mohsinPrompt, new RegExp(`Later user authorization.*${authorization}`),
      "Every subsequent specialist prompt must carry the stored later authorization");
    await emitReview(f, first.members[1]!.id, first.task.id, "next-reviewer-approval", {
      decision: "approved", feedback: "The product evidence is complete.",
    });
    await until(() => reviews(f).every(review => review.status === "approved"), "The re-review sequence did not complete");
    assert.equal(f.tasks.getTask(first.task.id).workflow?.state, "ready_for_review");
  } finally { await f.close(); }
});

test("non-blocking specialist observations remain distinct from approval", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Faysal"]);
    await (f.agents as any).queueDirectTaskReviews(first.task.id, "QA evidence");
    await emitReview(f, first.members[0]!.id, first.task.id, "non-blocking-observation", {
      decision: "observation", feedback: "The optional chart label could be shorter; this does not block acceptance.",
    });
    await until(() => reviews(f)[0]!.status === "observed", "Non-blocking observation was not retained distinctly");
    assert.equal(reviews(f)[0]!.feedback_kind, "observation");
    assert.notEqual(reviews(f)[0]!.status, "approved");
  } finally { await f.close(); }
});

test("legacy coordinated reviews keep parallel fan-out while explicit workflows remain sequential", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem", "Mohsin", "Faysal"]);
    assert.equal((f.database.db.prepare("SELECT review_policy FROM orchestrator_task_creations WHERE task_id=?")
      .get(first.task.id) as any).review_policy, "sequential");
    f.database.db.prepare("UPDATE orchestrator_task_creations SET review_policy='legacy_parallel' WHERE task_id=?").run(first.task.id);
    f.database.db.prepare("UPDATE orchestrator_task_reviewers SET position=0").run();
    await (f.agents as any).queueDirectTaskReviews(first.task.id, "Legacy evidence");
    assert.deepEqual(reviews(f).map(review => review.status), ["awaiting_review", "awaiting_review", "awaiting_review"]);
  } finally { await f.close(); }
});

test("mixed legacy corrections take precedence while naming concurrent specialist reviews", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem", "Mohsin", "Faysal"]);
    f.database.db.prepare("UPDATE orchestrator_task_creations SET review_policy='legacy_parallel' WHERE task_id=?").run(first.task.id);
    f.agents.limit = 0;
    await (f.agents as any).queueDirectTaskReviews(first.task.id, "Mixed legacy evidence");
    f.database.db.prepare(`UPDATE orchestrator_task_reviewers
      SET status='changes_requested',latest_feedback='Add the missing mixed-state workflow proof',
        feedback_kind='in_scope_correction',feedback_delivery_status='pending'
      WHERE creation_id=(SELECT id FROM orchestrator_task_creations WHERE task_id=?) AND position=0`).run(first.task.id);

    let workflow = f.tasks.getTask(first.task.id).workflow!;
    assert.equal(workflow.state, "capacity_queued");
    assert.equal(workflow.owner, "Task session");
    assert.equal(workflow.blocker, "Add the missing mixed-state workflow proof");
    assert.match(workflow.nextAction, /corrections requested by Nathem/i);
    assert.match(workflow.nextAction, /Concurrent reviews: Mohsin, Faysal continue reviewing/i);
    assert.doesNotMatch(workflow.label, /Reviewing/i);

    f.database.db.prepare(`UPDATE orchestrator_task_reviewers SET feedback_delivery_status='failed'
      WHERE creation_id=(SELECT id FROM orchestrator_task_creations WHERE task_id=?) AND position=0`).run(first.task.id);
    workflow = f.tasks.getTask(first.task.id).workflow!;
    assert.equal(workflow.state, "blocked");
    assert.equal(workflow.owner, "Task session");
    assert.match(workflow.nextAction, /retry delivery/i);
    assert.match(workflow.nextAction, /Mohsin, Faysal/);
  } finally { await f.close(); }
});

test("fresh task evidence requeues older legacy corrections instead of leaving the review chain idle", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem", "Mohsin", "Faysal"]);
    f.agents.limit = 0;
    f.database.db.prepare("UPDATE orchestrator_task_creations SET review_policy='legacy_parallel' WHERE task_id=?").run(first.task.id);
    f.database.db.prepare(`UPDATE orchestrator_task_reviewers SET status=CASE position
      WHEN 0 THEN 'approved' ELSE 'changes_requested' END WHERE creation_id=(
        SELECT id FROM orchestrator_task_creations WHERE task_id=?)`).run(first.task.id);

    await (f.agents as any).resumeDirectReviewAutomation();
    assert.deepEqual(reviews(f).map(review => review.status), ["approved", "awaiting_review", "awaiting_review"]);
    assert.equal((f.database.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages
      WHERE json_extract(metadata_json,'$.responseTarget.type')='direct_review'`).get() as any).n, 2);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM team_dispatches WHERE status='pending'").get() as any).n, 2);

    await f.restart();
    f.agents.limit = 0;
    await (f.agents as any).resumeQueues();
    assert.deepEqual(reviews(f).map(review => review.status), ["approved", "awaiting_review", "awaiting_review"]);
    assert.equal((f.database.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages
      WHERE json_extract(metadata_json,'$.responseTarget.type')='direct_review'`).get() as any).n, 2,
      "Restart must not duplicate freshly requeued specialist reviews");
  } finally { await f.close(); }
});

test("restart orders overlapping reviews only with an explicit sequential policy", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem", "Mohsin", "Faysal"]);
    f.database.db.prepare("UPDATE orchestrator_task_creations SET review_policy='legacy_parallel' WHERE task_id=?").run(first.task.id);
    f.agents.limit = 3;
    await (f.agents as any).queueDirectTaskReviews(first.task.id, "Seeded overlap with an ordered-policy signal");
    await until(() => reviews(f).every(review => review.status === "awaiting_review"), "Overlapping reviews were not seeded");
    f.database.db.prepare("UPDATE orchestrator_task_creations SET review_policy='sequential' WHERE task_id=?").run(first.task.id);

    await f.restart();
    f.agents.limit = 0;
    await (f.agents as any).resumeQueues();
    assert.deepEqual(reviews(f).map(review => review.status), ["awaiting_review", "pending", "pending"]);
    assert.equal((f.database.db.prepare("SELECT review_policy FROM orchestrator_task_creations WHERE task_id=?")
      .get(first.task.id) as any).review_policy, "sequential");
    assert.ok((f.database.db.prepare("SELECT COUNT(*) AS n FROM team_dispatches WHERE source_type='task' AND status='failed'")
      .get() as any).n >= 2);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM team_dispatches WHERE source_type='task' AND status='pending'")
      .get() as any).n, 1);
  } finally { await f.close(); }
});

test("restart preserves a seeded non-WAS legacy overlap without inferring reviewer order", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem", "Mohsin", "Faysal"]);
    assert.notEqual(first.task.humanId, "WAS-0051");
    f.database.db.prepare("UPDATE orchestrator_task_creations SET review_policy='legacy_parallel' WHERE task_id=?").run(first.task.id);
    // The persistent orchestrator turn occupies one slot; three slots leave two
    // reviewers running while the third review is durably capacity queued.
    f.agents.limit = 3;
    await (f.agents as any).queueDirectTaskReviews(first.task.id, "Seeded legacy evidence");
    await until(() => reviews(f).every(review => review.status === "awaiting_review"), "Legacy reviews were not seeded concurrently");
    const reviewerWork = () => first.members.map(member => {
      const session = f.agents.team.ensureTaskSession(member.id, first.task.id);
      return f.agents.workspace("orchestrator", memberSessionOwnerId(session.id));
    });
    await until(() => reviewerWork().filter(workspace => workspace.session.runState === "running").length === 2
      && reviewerWork().filter(workspace => workspace.hasPendingMessages).length === 1,
    "Two legacy reviewers were not active with the remaining review capacity queued");

    const snapshot = () => ({
      creation: f.database.db.prepare(`SELECT review_policy,reviewer_ids_json FROM orchestrator_task_creations
        WHERE task_id=?`).get(first.task.id),
      reviewers: f.database.db.prepare(`SELECT id,status,position,updated_at FROM orchestrator_task_reviewers
        WHERE creation_id=(SELECT id FROM orchestrator_task_creations WHERE task_id=?) ORDER BY rowid`).all(first.task.id),
      prompts: f.database.db.prepare(`SELECT id,owner_id,body,metadata_json,cancelled_at FROM chat_messages
        WHERE json_extract(metadata_json,'$.responseTarget.type')='direct_review' ORDER BY rowid`).all(),
      pendingPrompts: f.database.db.prepare(`SELECT pm.message_id,pm.dispatch_order FROM pending_messages pm
        JOIN chat_messages cm ON cm.id=pm.message_id
        WHERE json_extract(cm.metadata_json,'$.responseTarget.type')='direct_review' ORDER BY pm.dispatch_order`).all(),
      dispatches: f.database.db.prepare(`SELECT id,status,error,updated_at FROM team_dispatches
        WHERE source_type='task' ORDER BY rowid`).all(),
    });
    const beforeRestart = snapshot();
    await f.restart();
    f.agents.limit = 0;
    await (f.agents as any).resumeQueues();
    assert.deepEqual(reviews(f).map(review => review.status), ["awaiting_review", "awaiting_review", "awaiting_review"]);
    assert.deepEqual(snapshot(), beforeRestart,
      "Legacy-parallel policy, reviewer states, prompts, pending work, and dispatches must survive restart unchanged");
  } finally { await f.close(); }
});

test("legacy review migration is non-mutating and idempotent across replay", () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-review-migration-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost", dataDir: root,
    backupDir: join(root, "backups"), sessionDays: 365 };
  const path = join(root, "legacy.sqlite");
  try {
    let database = new AppDatabase(config, path);
    const tasks = new TaskService(database);
    const project = tasks.createProject({ name: "Legacy", prefix: "LEG", rootDirectory: root }, "user");
    const task = tasks.createTask({ projectId: project.id, title: "Legacy parallel review", status: "in_review" }, "user");
    const creation = randomUUID();
    const ids = [randomUUID(), randomUUID()].sort();
    const stamp = new Date().toISOString();
    for (const [index, id] of ids.entries()) database.db.prepare(`INSERT INTO team_members
      (id,name,title,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, `Legacy reviewer ${index}`, "Specialist", "Review only", stamp, stamp);
    database.db.prepare(`INSERT INTO orchestrator_task_creations
      (id,source_key,action_key,request_hash,authorization_text,project_id,task_id,reviewer_ids_json,review_policy,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(creation, "legacy", "legacy", "hash", "Old authorization", project.id, task.id,
        JSON.stringify(ids), "legacy_parallel", stamp);
    database.db.prepare(`INSERT INTO orchestrator_task_reviewers
      (id,creation_id,member_id,snapshot_name,snapshot_title,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), creation, ids[0], "First snapshot", "Specialist", 17, stamp, stamp);
    database.db.prepare(`INSERT INTO orchestrator_task_reviewers
      (id,creation_id,member_id,snapshot_name,snapshot_title,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), creation, ids[1], "Second snapshot", "Specialist", 3, stamp, stamp);
    const beforeJson = (database.db.prepare("SELECT reviewer_ids_json FROM orchestrator_task_creations WHERE id=?").get(creation) as any).reviewer_ids_json;
    const beforePositions = (database.db.prepare("SELECT position FROM orchestrator_task_reviewers WHERE creation_id=? ORDER BY rowid")
      .all(creation) as Array<{ position: number }>).map(row => row.position);
    database.db.exec("ALTER TABLE orchestrator_task_creations DROP COLUMN review_policy");
    database.close();

    for (let replay = 0; replay < 2; replay += 1) {
      database = new AppDatabase(config, path);
      const migrated = database.db.prepare("SELECT reviewer_ids_json,review_policy FROM orchestrator_task_creations WHERE id=?")
        .get(creation) as any;
      assert.equal(migrated.review_policy, "legacy_parallel");
      assert.equal(migrated.reviewer_ids_json, beforeJson);
      assert.deepEqual((database.db.prepare("SELECT position FROM orchestrator_task_reviewers WHERE creation_id=? ORDER BY rowid")
        .all(creation) as Array<{ position: number }>).map(row => row.position), beforePositions);
      database.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("closed coordinated tasks never project an active workflow", async () => {
  const f = coordinationFixture();
  try {
    const first = await reviewedTask(f, ["Nathem"]);
    f.tasks.transition(first.task.id, { to: "closed", outcome: "completed" }, "user");
    assert.equal(f.tasks.getTask(first.task.id).workflow, undefined);
    f.database.db.prepare("UPDATE tasks SET outcome='cancelled' WHERE id=?").run(first.task.id);
    assert.equal(f.tasks.getTask(first.task.id).workflow, undefined);
  } finally { await f.close(); }
});
