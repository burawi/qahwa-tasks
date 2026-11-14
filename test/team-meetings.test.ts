import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    assert.equal(start.params.sandboxPolicy.type, "readOnly");
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
    f.emit([memberAgent.threadId && memberAgent.activeTurnId ? { method: "turn/completed", params: { threadId: memberAgent.threadId, turn: { id: memberAgent.activeTurnId, status: "completed" } } } : null,
      orchestratorAgent.threadId && orchestratorAgent.activeTurnId ? { method: "turn/completed", params: { threadId: orchestratorAgent.threadId, turn: { id: orchestratorAgent.activeTurnId, status: "completed" } } } : null].filter(Boolean));
    await until(() => f.agents.workspace("orchestrator", memberOwner).session.runState === "idle", "Member advisory turn did not settle");
  } finally { f.close(); }
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
