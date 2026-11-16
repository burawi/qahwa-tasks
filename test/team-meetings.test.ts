import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAgentEnvelope } from "../src/server/agent-service.js";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import { AppDatabase } from "../src/server/database.js";
import { TeamService, meetingParticipantOwnerId, memberSessionOwnerId } from "../src/server/team-service.js";
import { coordinationFixture, until } from "./helpers/orchestrator-replies.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qahwa-team-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "http://localhost",
    dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  return { root, config, database, team: new TeamService(database), close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("team identities are unique, titled, and historical meeting snapshots survive removal", () => {
  const f = fixture();
  try {
    const qa = f.team.createMember({ name: "Maya", title: "QA Lead", instructions: "Find release risk and advise task sessions." });
    const ops = f.team.createMember({ name: "Sami", title: "DevOps Manager", instructions: "Review deployment plans." });
    assert.throws(() => f.team.createMember({ name: "maya", title: "Other", instructions: "Duplicate" }), { code: "duplicate_team_member" });
    const participants = f.team.availableParticipants();
    const meeting = f.team.createMeeting({ title: "Release readiness", participantIds: participants.map(item => `${item.type}:${item.id}`) });
    assert.deepEqual(meeting.participants.map(item => item.name), ["Orchestrator", "Maya", "Sami"]);
    f.team.archiveMember(qa.id);
    assert.deepEqual(f.team.listMembers().map(item => item.id), [ops.id]);
    assert.equal(f.team.getMeeting(meeting.id).participants.find(item => item.id === qa.id)?.title, "QA Lead");
  } finally { f.close(); }
});

test("meeting dispatch addresses everyone by default and only named participants when mentioned", () => {
  const f = fixture();
  try {
    const qa = f.team.createMember({ name: "Maya", title: "QA Lead", instructions: "Advise QA." });
    const ops = f.team.createMember({ name: "Sami", title: "DevOps Manager", instructions: "Advise ops." });
    const meeting = f.team.createMeeting({ title: "Launch", participantIds: f.team.availableParticipants().map(item => `${item.type}:${item.id}`) });
    assert.equal(f.team.participantsForMessage(meeting.id, "What do you think?").length, 3);
    assert.deepEqual(f.team.participantsForMessage(meeting.id, "@Maya please review this").map(item => item.id), [qa.id]);
    assert.deepEqual(f.team.participantsForMessage(meeting.id, "@maya and @SAMI please compare").map(item => item.id), [qa.id, ops.id]);
  } finally { f.close(); }
});

test("orchestrator meeting access resolves zero, one, multiple, and archived meetings safely", () => {
  const f = fixture();
  try {
    const zero = f.team.orchestratorMeetingAccess("Summarize the meeting");
    assert.equal(zero.resolution, "none");
    assert.deepEqual(zero.activeMeetings, []);

    const participantIds = f.team.availableParticipants().map(item => `${item.type}:${item.id}`);
    const first = f.team.createMeeting({ title: "Release readiness", participantIds });
    f.team.addMeetingMessage(first.id, { speakerType: "user", speakerId: null, speakerName: "You", speakerTitle: "" }, "First decision");
    f.team.addMeetingMessage(first.id, { speakerType: "orchestrator", speakerId: "main", speakerName: "Orchestrator", speakerTitle: "Orchestrator" }, "First answer");
    const one = f.team.orchestratorMeetingAccess("What happened in the meeting?");
    assert.equal(one.resolution, "resolved");
    assert.equal(one.meeting?.id, first.id);
    assert.deepEqual(one.meeting?.transcript.map(message => message.body), ["First decision", "First answer"]);
    assert.equal(one.meeting?.participants[0]?.type, "orchestrator");

    const second = f.team.createMeeting({ title: "Launch timing", participantIds });
    const many = f.team.orchestratorMeetingAccess("What happened in the meeting?");
    assert.equal(many.resolution, "ambiguous");
    assert.deepEqual(new Set(many.candidates?.map(meeting => meeting.id)), new Set([first.id, second.id]));

    f.team.archiveMeeting(first.id);
    const activeOnly = f.team.orchestratorMeetingAccess("Open the meeting transcript");
    assert.equal(activeOnly.resolution, "resolved");
    assert.equal(activeOnly.meeting?.id, second.id);
    assert.equal(activeOnly.activeMeetings.some(meeting => meeting.id === first.id), false);
    assert.equal(activeOnly.archivedMeetings, undefined);
    const archived = f.team.orchestratorMeetingAccess("Open the archived Release readiness meeting transcript");
    assert.equal(archived.resolution, "resolved");
    assert.equal(archived.meeting?.id, first.id);
    assert.equal(archived.meeting?.status, "archived");
    assert.deepEqual(archived.meeting?.transcript.map(message => message.body), ["First decision", "First answer"]);
  } finally { f.close(); }
});

test("only the orchestrator prompt receives transcript context without device credentials", async () => {
  const f = coordinationFixture();
  try {
    const credentialMarker = "DEVICE-PUBLIC-KEY-MUST-STAY-PRIVATE";
    f.database.db.prepare(`INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at)
      VALUES ('meeting-device','Browser',?,'now','now')`).run(credentialMarker);
    const meeting = f.agents.team.createMeeting({ title: "Private planning",
      participantIds: f.agents.team.availableParticipants().map(item => `${item.type}:${item.id}`) });
    f.agents.team.addMeetingMessage(meeting.id, { speakerType: "user", speakerId: null, speakerName: "You", speakerTitle: "" }, "Transcript line one");
    f.agents.team.addMeetingMessage(meeting.id, { speakerType: "orchestrator", speakerId: "main", speakerName: "Orchestrator", speakerTitle: "Orchestrator" }, "Transcript line two");
    await f.agents.send("orchestrator", "main", "Summarize the meeting");
    const start = f.requests().filter(request => request.method === "turn/start").at(-1)!;
    const prompt = start.params.input[0].text as string;
    assert.match(prompt, /Authenticated internal meeting access:/);
    assert.match(prompt, /Private planning/);
    assert.match(prompt, /Transcript line one/);
    assert.match(prompt, /Transcript line two/);
    assert.doesNotMatch(prompt, new RegExp(credentialMarker));
    assert.equal(start.params.sandboxPolicy.type, "dangerFullAccess");
    const startedThread = f.requests().filter(request => request.method === "thread/start").at(-1)!;
    assert.match(startedThread.params.developerInstructions, /Never perform project implementation/);
    const session = f.agents.workspace("orchestrator", "main").session;
    f.emit([{ method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.activeTurnId, status: "completed" } } }]);
    await until(() => f.agents.workspace("orchestrator", "main").session.runState === "idle", "Orchestrator turn did not settle");
  } finally { f.close(); }
});

test("meeting HTTP data remains behind paired-device authentication", async () => {
  const f = fixture();
  const app = await buildApp(f.config, f.database);
  try {
    f.database.db.prepare(`INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at)
      VALUES ('meeting-device','Browser','public-key','now','now')`).run();
    const meeting = f.team.createMeeting({ title: "Authenticated planning",
      participantIds: f.team.availableParticipants().map(item => `${item.type}:${item.id}`) });
    f.team.addMeetingMessage(meeting.id, { speakerType: "user", speakerId: null, speakerName: "You", speakerTitle: "" }, "Private transcript");
    assert.equal((await app.inject({ method: "GET", url: "/api/meetings" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `/api/meetings/${meeting.id}` })).statusCode, 401);
    const token = new AuthService(f.database, 365).createSession("test", "127.0.0.1", "meeting-device").token;
    const response = await app.inject({ method: "GET", url: `/api/meetings/${meeting.id}`,
      headers: { authorization: `Bearer ${token}`, origin: f.config.publicBaseUrl } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().messages[0].body, "Private transcript");
  } finally { await app.close(); f.close(); }
});

test("orchestrator team actions and member rollover markers are parsed but hidden from visible text", () => {
  const parsed = parseAgentEnvelope(`I'll set that up.\n<!-- qahwa-actions:[{"type":"member_create","name":"Maya","title":"QA Lead","instructions":"Advise QA","authorization":"add Maya"},{"type":"consult","memberId":"member-1","taskId":"QAH-0079","message":"Review this plan","authorization":"ask Maya"}] -->`);
  assert.deepEqual(parsed.actions.map(action => action.type), ["member_create", "consult"]);
  const rollover = parseAgentEnvelope(`Context is getting long.\n<!-- qahwa-context-rollover:{"summary":"Decisions and open risks"} -->`);
  assert.equal(rollover.contextRollover, "Decisions and open risks");
  assert.equal(rollover.body, "Context is getting long.");
  const management = parseAgentEnvelope(`Investigate the report.\n<!-- qahwa-management:{"kind":"evidence","summary":"Capture the live failure","projectId":"project-1","taskId":"WAS-0050"} -->`);
  assert.deepEqual(management.management, { kind: "evidence", summary: "Capture the live failure", projectId: "project-1", taskId: "WAS-0050" });
  assert.equal(management.body, "Investigate the report.");
  const review = parseAgentEnvelope(`The result needs one correction.\n<!-- qahwa-management-review:{"decision":"changes_requested","feedback":"Add mobile evidence"} -->`);
  assert.deepEqual(review.managementReview, { decision: "changes_requested", feedback: "Add mobile evidence" });
});

test("each member gets one persistent advisory session per task plus separate manual sessions", () => {
  const f = coordinationFixture();
  try {
    const member = f.agents.team.createMember({ name: "Maya", title: "QA Lead", instructions: "Advise QA." });
    const task = f.task("Release readiness");
    const first = f.agents.team.ensureTaskSession(member.id, task.id);
    const same = f.agents.team.ensureTaskSession(member.id, task.humanId);
    const manual = f.agents.team.createManualSession(member.id, { title: "Testing strategy" });
    assert.equal(first.id, same.id);
    assert.equal(first.kind, "task");
    assert.equal(first.taskHumanId, task.humanId);
    assert.equal(manual.kind, "manual");
    assert.deepEqual(new Set(f.agents.team.listMemberSessions(member.id).map(session => session.id)), new Set([first.id, manual.id]));
  } finally { f.close(); }
});

test("a task consultation is recorded in that member's task session", async () => {
  const f = coordinationFixture();
  try {
    const member = f.agents.team.createMember({ name: "Maya", title: "QA Lead", instructions: "Advise QA." });
    const task = f.task("Release readiness");
    const authorization = "Ask Maya to review the release risk";
    await f.reply(`I’ll ask Maya.\n<!-- qahwa-actions:[{"type":"consult","memberId":"${member.id}","taskId":"${task.humanId}","message":"Review the release risk","authorization":"${authorization}"}] -->`, authorization);
    await until(() => f.agents.team.listMemberSessions(member.id).length === 1, "Task advisory session was not created");
    const session = f.agents.team.listMemberSessions(member.id)[0]!;
    assert.equal(session.kind, "task");
    assert.equal(session.taskId, task.id);
    const memberOwner = memberSessionOwnerId(session.id);
    const messages = f.agents.workspace("orchestrator", memberOwner).messages;
    assert.ok(messages.some(message => message.role === "system" && message.body.includes("Review the release risk")));
    await until(() => Boolean(f.agents.workspace("orchestrator", memberOwner).session.activeTurnId), "Member advisory turn did not start");
    const memberAgent = f.agents.workspace("orchestrator", memberOwner).session;
    const orchestratorAgent = f.agents.workspace("orchestrator", "main").session;
    f.emit([memberAgent.threadId && memberAgent.activeTurnId ? { method: "item/completed", params: { threadId: memberAgent.threadId,
      turnId: memberAgent.activeTurnId, item: { id: "consultation-response", type: "agentMessage", phase: "final_answer",
        text: "One product correction is required before approval." } } } : null,
      memberAgent.threadId && memberAgent.activeTurnId ? { method: "turn/completed", params: { threadId: memberAgent.threadId, turn: { id: memberAgent.activeTurnId, status: "completed" } } } : null,
      orchestratorAgent.threadId && orchestratorAgent.activeTurnId ? { method: "turn/completed", params: { threadId: orchestratorAgent.threadId, turn: { id: orchestratorAgent.activeTurnId, status: "completed" } } } : null].filter(Boolean));
    await until(() => f.agents.workspace("orchestrator", memberOwner).session.runState === "idle", "Member advisory turn did not settle");
    await until(() => f.agents.workspace("task", task.id).messages.some(message => message.body.includes("One product correction")),
      "Member response was not copied to the task");
    const dispatch = f.database.db.prepare("SELECT id FROM team_dispatches WHERE source_id=? ORDER BY created_at DESC LIMIT 1")
      .get(task.id) as { id: string };
    await until(() => Boolean(f.database.db.prepare(`SELECT 1 FROM session_events
      WHERE owner_type='orchestrator' AND owner_id='main' AND event_type='team.consultation_returned'
        AND json_extract(payload_json,'$.dispatchId')=?`).get(dispatch.id)), "Returned consultation did not notify the orchestrator");
  } finally { f.close(); }
});

test("restart recovers a recently returned legacy consultation that was copied without notifying the orchestrator", async () => {
  const f = coordinationFixture();
  try {
    const member = f.agents.team.createMember({ name: "Maya", title: "Product Lead", instructions: "Review product journeys." });
    const task = f.task("Legacy product review");
    const traceId = (f.agents as any).addMessage("task", task.id, "system", "Labib asked Maya for product review");
    const dispatchId = f.agents.team.createDispatch(traceId, "task", task.id, f.agents.team.participant(member));
    const responseId = (f.agents as any).addMessage("task", task.id, "assistant", "Changes requested: synchronize Back and Forward navigation.", {
      speaker: { type: "member", id: member.id, name: member.name, title: member.title, avatar: member.avatar },
      teamDispatchId: dispatchId,
    });
    f.agents.team.completeDispatch(dispatchId, responseId);
    assert.equal(f.database.db.prepare("SELECT 1 FROM session_events WHERE event_type='team.consultation_returned'").get(), undefined);
    await f.restart();
    await until(() => Boolean(f.database.db.prepare(`SELECT 1 FROM session_events
      WHERE owner_type='orchestrator' AND owner_id='main' AND event_type='team.consultation_returned'
        AND json_extract(payload_json,'$.dispatchId')=?`).get(dispatchId)), "Restart did not recover the returned consultation");
    await until(() => Boolean(f.agents.workspace("orchestrator", "main").session.activeTurnId),
      "Recovered consultation did not start an orchestrator observation turn");
  } finally { await f.close(); }
});

test("automated supervision can return an in-review legacy task only to its established reviewer", async () => {
  const f = coordinationFixture();
  try {
    const quote = "Keep authorized work moving through its review loop";
    f.database.setSetting("orchestrator_standing_directive", JSON.stringify({
      id: "review-loop", instruction: "Supervise authorized tasks through review",
      sourceQuote: quote, createdAt: new Date().toISOString(),
    }));
    const reviewer = f.agents.team.createMember({ name: "Maya", title: "Product Lead", instructions: "Review product journeys." });
    const stranger = f.agents.team.createMember({ name: "Sami", title: "QA Lead", instructions: "Review quality." });
    const task = f.task("Legacy product review");
    f.tasks.transition(task.id, { to: "in_progress" }, "codex");
    f.tasks.transition(task.id, { to: "in_review" }, "codex");
    f.agents.limit = 0;
    const traceId = (f.agents as any).addMessage("task", task.id, "system", "Maya reviewed the first result");
    const dispatchId = f.agents.team.createDispatch(traceId, "task", task.id, f.agents.team.participant(reviewer));
    const responseId = (f.agents as any).addMessage("task", task.id, "assistant", "One correction is required.");
    f.agents.team.completeDispatch(dispatchId, responseId);

    const repeated = await (f.agents as any).applyOrchestratorActions([{
      type: "consult", memberId: reviewer.id, taskId: task.humanId,
      message: "Re-review the corrected live evidence", authorization: quote,
    }], undefined, null, "automated-review", null);
    assert.equal(repeated[0]?.status, "queued");
    assert.equal((f.database.db.prepare(`SELECT count(*) AS count FROM team_dispatches
      WHERE source_type='task' AND source_id=? AND participant_id=?`).get(task.id, reviewer.id) as { count: number }).count, 2);

    const unrelated = await (f.agents as any).applyOrchestratorActions([{
      type: "consult", memberId: stranger.id, taskId: task.humanId,
      message: "Join this review", authorization: quote,
    }], undefined, null, "automated-new-reviewer", null);
    assert.equal(unrelated[0]?.status, "failed");
    assert.match(unrelated[0]!.message, /not authorized/i);
    assert.equal((f.database.db.prepare(`SELECT count(*) AS count FROM team_dispatches
      WHERE source_type='task' AND source_id=? AND participant_id=?`).get(task.id, stranger.id) as { count: number }).count, 0);
  } finally { await f.close(); }
});

test("meeting replies use hidden meeting-only context and are copied into the durable transcript", async () => {
  const f = coordinationFixture();
  try {
    const member = f.agents.team.createMember({ name: "Maya", title: "QA Lead", instructions: "Advise QA." });
    const meeting = f.agents.team.createMeeting({ title: "Readiness", participantIds: [`member:${member.id}`] });
    await f.agents.sendMeetingMessage(meeting.id, "What is the main release risk?");
    assert.deepEqual(f.agents.team.listMemberSessions(member.id), []);
    const ownerId = meetingParticipantOwnerId(meeting.id, { type: "member", id: member.id });
    const session = f.agents.workspace("orchestrator", ownerId).session;
    assert.ok(session.threadId && session.activeTurnId);
    f.emit([
      { method: "item/completed", params: { threadId: session.threadId, turnId: session.activeTurnId,
        item: { id: "member-advice", type: "agentMessage", phase: "final_answer", text: "Run the rollback rehearsal before release." } } },
      { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.agents.team.messages(meeting.id).some(message => message.speakerId === member.id), "Member response was not copied to the meeting");
    const messages = f.agents.team.messages(meeting.id);
    assert.equal(messages[0]?.status, "delivered");
    assert.deepEqual(messages.map(message => [message.speakerName, message.body]), [
      ["You", "What is the main release risk?"], ["Maya", "Run the rollback rehearsal before release."],
    ]);
    assert.equal(f.agents.workspace("orchestrator", ownerId).session.threadId, session.threadId);
    assert.deepEqual(f.agents.team.listMemberSessions(member.id), []);
  } finally { f.close(); }
});

test("member evidence access is project scoped, credential free, browser rendered, and mutation blocked", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<html><head><title>Wassala evidence</title></head><body><main><h1>Admin overview</h1><button>Review orders</button></main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/admin`;
  const f = coordinationFixture();
  try {
    const projectRoot = join(f.root, "wassala");
    mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
    writeFileSync(join(projectRoot, "artifacts", "screen.png"), Buffer.from("image evidence"));
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: projectRoot }, "user");
    const task = f.tasks.createTask({ projectId: project.id, title: "Admin review", status: "todo" }, "user");
    f.database.db.prepare(`INSERT INTO chat_messages(id,owner_type,owner_id,role,body,created_at) VALUES (?, 'task', ?, 'assistant', ?, ?)`)
      .run(randomUUID(), task.id, `Live admin: ${url}`, new Date().toISOString());
    const member = f.agents.team.createMember({ name: "Jamil", title: "Product Manager", instructions: "Review product UX from evidence." });
    f.database.db.prepare(`INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('secret-device','Browser',?,'now','now')`)
      .run("CREDENTIAL-MUST-NOT-ENTER-MODEL-CONTEXT");
    const meeting = f.agents.team.createMeeting({ title: "Kick-off", participantIds: [`member:${member.id}`] });
    await f.agents.sendMeetingMessage(meeting.id, "@Jamil inspect the Wassala admin directly");
    const ownerId = meetingParticipantOwnerId(meeting.id, { type: "member", id: member.id });
    const session = f.agents.workspace("orchestrator", ownerId).session;
    const threadStart = f.requests().find(request => request.method === "thread/start" && request.params.cwd === projectRoot)!;
    assert.deepEqual(threadStart.params.runtimeWorkspaceRoots, [projectRoot]);
    assert.equal(threadStart.params.sandbox, "read-only");
    assert.equal(threadStart.params.config.apps._default.destructive_enabled, false);
    assert.equal(threadStart.params.config.apps._default.open_world_enabled, false);
    assert.equal(threadStart.params.config.mcp_servers.qahwa_tasks.enabled, false);
    assert.equal(threadStart.params.dynamicTools[0].name, "qahwa_evidence");
    const turnStart = f.requests().find(request => request.method === "turn/start" && request.params.threadId === session.threadId)!;
    assert.deepEqual(turnStart.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.doesNotMatch(turnStart.params.input[0].text, /CREDENTIAL-MUST-NOT-ENTER-MODEL-CONTEXT/);

    f.emit([{ jsonrpc: "2.0", id: 9101, method: "item/tool/call", params: { threadId: session.threadId, turnId: session.activeTurnId,
      callId: "capture-1", namespace: "qahwa_evidence", tool: "inspect_page", arguments: { url } } }]);
    await until(() => f.requests().some((request: any) => request.id === 9101 && request.result?.success === true), "Browser evidence was not returned");
    const evidenceResponse = f.requests().find((request: any) => request.id === 9101 && request.result?.success === true) as any;
    assert.match(evidenceResponse.result.contentItems[0].text, /Wassala evidence/);
    assert.match(evidenceResponse.result.contentItems[0].text, /Admin overview/);
    assert.match(evidenceResponse.result.contentItems[1].imageUrl, /^data:image\/png;base64,/);
    assert.equal(Number((f.database.db.prepare("SELECT COUNT(*) AS count FROM team_evidence_artifacts WHERE owner_id=?").get(ownerId) as { count: number }).count), 1);

    f.emit([
      { jsonrpc: "2.0", id: 9102, method: "item/tool/call", params: { threadId: session.threadId, turnId: session.activeTurnId,
        callId: "capture-2", namespace: "qahwa_evidence", tool: "inspect_page", arguments: { url: "https://example.com" } } },
      { jsonrpc: "2.0", id: 9103, method: "item/fileChange/requestApproval", params: { threadId: session.threadId, turnId: session.activeTurnId, itemId: "write-1", reason: "edit", changes: [] } },
    ]);
    await until(() => f.requests().some((request: any) => request.id === 9102 && request.result?.success === false)
      && f.requests().some((request: any) => request.id === 9103 && request.result?.decision?.denied), "Denied evidence/write responses were not returned");
    const denied = f.requests().find((request: any) => request.id === 9103 && request.result?.decision?.denied) as any;
    assert.match(denied.result.decision.denied.rejection, /Supervisory sessions cannot mutate/);
    assert.ok(f.database.db.prepare("SELECT 1 FROM session_events WHERE owner_id=? AND event_type='supervisor.mutation_denied'").get(ownerId));
  } finally {
    f.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("meeting management requests preserve origin authorization and specialist review state", () => {
  const f = fixture();
  try {
    const member = f.team.createMember({ name: "Maya", title: "QA Lead", instructions: "Review evidence." });
    const project = f.database.db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string } | undefined;
    if (!project) f.database.db.prepare(`INSERT INTO projects(id,name,prefix,root_directory,created_at,updated_at) VALUES ('project-1','Wassala','WAS',?,'now','now')`).run(f.root);
    const meeting = f.team.createMeeting({ title: "Release", participantIds: [`member:${member.id}`] });
    const sourceMessageId = f.team.addMeetingMessage(meeting.id, { speakerType: "user", speakerId: null, speakerName: "You", speakerTitle: "" }, "Verify the release");
    const request = f.team.createManagementRequest({ meetingId: meeting.id, sourceMessageId, requester: f.team.participant(member),
      kind: "evidence", summary: "Verify the release evidence", projectId: project?.id ?? "project-1" });
    assert.equal(request.status, "pending");
    assert.equal(request.sourceMessageId, sourceMessageId);
    f.database.db.prepare("UPDATE team_management_requests SET status='delegated' WHERE id=?").run(request.id);
    f.team.markManagementReviewQueued(request.id);
    const reviewed = f.team.saveManagementReview(request.id, "changes_requested", "Add a mobile screenshot");
    assert.equal(reviewed.status, "changes_requested");
    assert.equal(reviewed.reviewCount, 1);
    assert.equal(reviewed.latestFeedback, "Add a mobile screenshot");
  } finally { f.close(); }
});

test("meeting-originated task creation shares the idempotent internal creation path", async () => {
  const f = coordinationFixture();
  try {
    f.agents.limit = 0;
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const member = f.agents.team.createMember({ name: "Jamil", title: "Product Designer", instructions: "Review UX evidence." });
    const meeting = f.agents.team.createMeeting({ title: "Kick-off", participantIds: [`member:${member.id}`] });
    const authorization = "Create a read-only task to gather the admin evidence";
    const sourceMessageId = f.agents.team.addMeetingMessage(meeting.id,
      { speakerType: "user", speakerId: null, speakerName: "You", speakerTitle: "" }, authorization);
    const request = f.agents.team.createManagementRequest({ meetingId: meeting.id, sourceMessageId,
      requester: f.agents.team.participant(member), kind: "evidence", summary: "Gather the admin evidence", projectId: project.id });
    const action = { type: "management_create_task", requestId: request.id, projectId: project.id,
      title: "Gather Wassala admin evidence", description: "Capture mobile and desktop evidence",
      accessMode: "read-only", authorization };
    const apply = () => (f.agents as any).applyOrchestratorActions([action], undefined, null, "meeting-create", null);
    await apply();
    await apply();
    const tasks = f.tasks.listTasks({ tab: "all" });
    assert.equal(tasks.length, 1);
    assert.equal(f.agents.team.getManagementRequest(request.id).taskId, tasks[0]!.id);
    assert.equal(f.agents.workspace("task", tasks[0]!.id).session.accessMode, "read-only");
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS n FROM orchestrator_task_creations WHERE source_key=?")
      .get(`meeting:${sourceMessageId}`) as { n: number }).n, 1);
  } finally { f.close(); }
});

test("direct task results return through the specialist correction and approval loop", async () => {
  const f = coordinationFixture();
  try {
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const member = f.agents.team.createMember({ name: "Jamil", title: "Product Designer", instructions: "Review UX evidence." });
    const authorization = "Create the Wassala redesign and let Jamil review every result";
    await f.agents.send("orchestrator", "main", authorization);
    const sourceMessageId = f.agents.workspace("orchestrator", "main").messages.find(message => message.role === "user")!.id;
    const action = { type: "create_task", idempotencyKey: "reviewed-redesign", projectId: project.id,
      title: "Redesign Wassala Admin", goal: "Deliver a coherent redesign", details: ["Preserve workflows"],
      doneWhen: ["Jamil approves"], reviewerIds: [member.id], accessMode: "worktree-write", startNow: false, authorization };
    await (f.agents as any).applyOrchestratorActions([action], authorization, null, "direct-create", sourceMessageId);
    const task = f.tasks.listTasks({ tab: "all" })[0]!;
    const review = () => f.database.db.prepare(`SELECT * FROM orchestrator_task_reviewers LIMIT 1`).get() as any;

    await (f.agents as any).queueDirectTaskReviews(task.id, "Initial redesign result");
    await until(() => review().status === "awaiting_review", "Direct specialist review was not queued");
    const memberSession = f.agents.team.ensureTaskSession(member.id, task.id);
    const ownerId = memberSessionOwnerId(memberSession.id);
    await until(() => Boolean(f.agents.workspace("orchestrator", ownerId).session.activeTurnId), "Specialist review turn did not start");
    let session = f.agents.workspace("orchestrator", ownerId).session;
    f.emit([
      { method: "item/completed", params: { threadId: session.threadId, turnId: session.activeTurnId,
        item: { id: "direct-corrections", type: "agentMessage", phase: "final_answer",
          text: `The hierarchy needs correction.\n<!-- qahwa-management-review:{"decision":"changes_requested","feedback":"Strengthen the hierarchy"} -->` } } },
      { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.activeTurnId, status: "completed" } } },
    ]);
    await until(() => review().status === "pending" && review().feedback_delivery_status === "delivered",
      "Specialist corrections were not delivered automatically");
    await until(() => f.agents.workspace("orchestrator", ownerId).session.runState === "idle", "First specialist review did not finish");
    assert.ok(f.agents.workspace("task", task.id).messages.some(message => message.body.includes("Strengthen the hierarchy")));

    f.tasks.transition(task.id, { to: "in_progress" }, "codex");
    f.tasks.submitForReview(task.id, { summary: "Corrected redesign result" }, "codex");
    await (f.agents as any).queueDirectTaskReviews(task.id, "Corrected redesign result");
    await until(() => Boolean(f.agents.workspace("orchestrator", ownerId).session.activeTurnId), "Second specialist review did not start");
    session = f.agents.workspace("orchestrator", ownerId).session;
    f.emit([
      { method: "item/completed", params: { threadId: session.threadId, turnId: session.activeTurnId,
        item: { id: "direct-approval", type: "agentMessage", phase: "final_answer",
          text: `The corrected hierarchy meets the bar.\n<!-- qahwa-management-review:{"decision":"approved","feedback":"Approved"} -->` } } },
      { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.activeTurnId, status: "completed" } } },
    ]);
    await until(() => review().status === "approved", "Specialist approval was not recorded");
    assert.equal(review().review_count, 2);
  } finally { f.close(); }
});

test("meeting work is delegated once and returned to the requesting specialist for approval", async () => {
  const f = coordinationFixture();
  try {
    const project = f.tasks.createProject({ name: "Wassala", prefix: "WAS", rootDirectory: f.root }, "user");
    const task = f.task("Validate admin evidence", project.id);
    const member = f.agents.team.createMember({ name: "Jamil", title: "Product Manager", instructions: "Review product evidence." });
    const meeting = f.agents.team.createMeeting({ title: "Kick-off", participantIds: [`member:${member.id}`] });
    const userRequest = "@Jamil validate the Wassala admin evidence";
    await f.agents.sendMeetingMessage(meeting.id, userRequest);
    const memberOwner = meetingParticipantOwnerId(meeting.id, { type: "member", id: member.id });
    let memberSession = f.agents.workspace("orchestrator", memberOwner).session;
    f.emit([
      { method: "item/completed", params: { threadId: memberSession.threadId, turnId: memberSession.activeTurnId,
        item: { id: "management-request", type: "agentMessage", phase: "final_answer",
          text: `I need a task to collect authenticated evidence.\n<!-- qahwa-management:{"kind":"evidence","summary":"Collect authenticated admin evidence","projectId":"${project.id}"} -->` } } },
      { method: "turn/completed", params: { threadId: memberSession.threadId, turn: { id: memberSession.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.agents.team.managementRequests(["pending"]).length === 1, "Management request was not persisted");
    const request = f.agents.team.managementRequests(["pending"])[0]!;
    await until(() => Boolean(f.agents.workspace("orchestrator", "main").session.activeTurnId), "Orchestrator did not receive the meeting action");
    const orchestrator = f.agents.workspace("orchestrator", "main").session;
    f.emit([
      { method: "item/completed", params: { threadId: orchestrator.threadId, turnId: orchestrator.activeTurnId,
        item: { id: "delegate-request", type: "agentMessage", phase: "final_answer",
          text: `I’ll coordinate the evidence task.\n<!-- qahwa-actions:[{"type":"management_delegate","requestId":"${request.id}","taskId":"${task.humanId}","message":"Collect and validate the requested evidence","authorization":"${userRequest}"}] -->` } } },
      { method: "turn/completed", params: { threadId: orchestrator.threadId, turn: { id: orchestrator.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.agents.team.getManagementRequest(request.id).status === "delegated", "Meeting request was not delegated");
    assert.ok(f.agents.workspace("task", task.id).messages.some(message => message.body.includes("Meeting management request from Jamil")));

    await until(() => Boolean(f.agents.workspace("task", task.id).session.activeTurnId), "Task intake did not start");
    let taskSession = f.agents.workspace("task", task.id).session;
    f.emit([
      { method: "item/completed", params: { threadId: taskSession.threadId, turnId: taskSession.activeTurnId,
        item: { id: "task-intake", type: "agentMessage", phase: "final_answer", text: `Scope is clear.\n<!-- qahwa-intake:{"ready":true,"accessMode":"read-only"} -->` } } },
      { method: "turn/completed", params: { threadId: taskSession.threadId, turn: { id: taskSession.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.agents.workspace("task", task.id).session.threadId !== taskSession.threadId
      && Boolean(f.agents.workspace("task", task.id).session.activeTurnId), "Task implementation handoff did not start");
    taskSession = f.agents.workspace("task", task.id).session;
    if (f.tasks.getTask(task.id).status === "todo") f.tasks.transition(task.id, { to: "in_progress" }, "codex");
    writeFileSync(join(f.root, "review-proof.png"), Buffer.from("rendered evidence captured"));
    f.emit([
      { method: "item/completed", params: { threadId: taskSession.threadId, turnId: taskSession.activeTurnId,
        item: { id: "task-result", type: "agentMessage", phase: "final_answer",
          text: `Evidence captured and validated.\n<!-- qahwa:{"message":"Evidence ready","tone":"green","surface":"chat","review":true,"validation":["Rendered workflow passed"],"limitations":["No deployment"],"artifacts":["review-proof.png"]} -->` } } },
      { method: "turn/completed", params: { threadId: taskSession.threadId, turn: { id: taskSession.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.agents.team.getManagementRequest(request.id).status === "awaiting_review", "Task result was not handed to the specialist");
    const output = f.tasks.getTask(task.id).outputs.at(-1)!;
    assert.deepEqual(output.validation, ["Rendered workflow passed"]);
    assert.deepEqual(output.limitations, ["No deployment"]);
    assert.equal(output.artifacts[0]?.filename, "review-proof.png");
    assert.equal(output.artifacts[0]?.availability, "available");
    await until(() => Boolean(f.agents.workspace("orchestrator", memberOwner).session.activeTurnId), "Specialist review turn did not start");
    memberSession = f.agents.workspace("orchestrator", memberOwner).session;
    assert.ok(memberSession.activeTurnId);
    const reviewPrompt = f.agents.workspace("orchestrator", memberOwner).messages.filter(message => message.role === "system").at(-1)?.body ?? "";
    assert.match(reviewPrompt, /Evidence captured and validated/);
    f.emit([
      { method: "item/completed", params: { threadId: memberSession.threadId, turnId: memberSession.activeTurnId,
        item: { id: "specialist-approval", type: "agentMessage", phase: "final_answer",
          text: `The evidence meets the product bar.\n<!-- qahwa-management-review:{"decision":"approved","feedback":"The evidence is concrete and sufficient"} -->` } } },
      { method: "turn/completed", params: { threadId: memberSession.threadId, turn: { id: memberSession.activeTurnId, status: "completed" } } },
    ]);
    await until(() => f.agents.team.getManagementRequest(request.id).status === "approved", "Specialist approval was not recorded");
    assert.ok(f.agents.team.messages(meeting.id).some(message => message.body.includes("meets the product bar")));
  } finally { f.close(); }
});
