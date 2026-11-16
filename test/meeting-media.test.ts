import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import { meetingAttachmentOwnerId, type AttachmentService } from "../src/server/attachment-service.js";
import { coordinationFixture } from "./helpers/orchestrator-replies.js";

test("meeting attachments are scoped, persist in history, reach participants, and retry without duplicates", async () => {
  const f = coordinationFixture();
  try {
    const timestamp = new Date().toISOString();
    f.database.db.prepare(`INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at)
      VALUES ('meeting-media-device','Browser','',?,?)`).run(timestamp, timestamp);
    const member = f.agents.team.createMember({ name: "Maya", title: "QA Lead", instructions: "Review evidence." });
    const meeting = f.agents.team.createMeeting({ title: "Attachment review", participantIds: [`member:${member.id}`] });
    const other = f.agents.team.createMeeting({ title: "Other meeting", participantIds: [`member:${member.id}`] });
    const attachments = Reflect.get(f.agents, "attachments") as AttachmentService;
    const upload = attachments.initiate("orchestrator", meetingAttachmentOwnerId(meeting.id), "meeting-media-device",
      { filename: "release-notes.txt", mediaType: "text/plain", size: 7 });
    attachments.appendChunk(upload.id, "meeting-media-device", 0, Buffer.from("context"));
    attachments.complete(upload.id, "meeting-media-device");
    assert.throws(() => attachments.prepareForMessage("orchestrator", meetingAttachmentOwnerId(other.id), "meeting-media-device", [upload.id]),
      { code: "attachment_forbidden" });

    const requestId = randomUUID();
    const first = await f.agents.sendMeetingMessage(meeting.id, "", [upload.id], "meeting-media-device", requestId);
    assert.equal(first.messages.filter(message => message.speakerType === "user").length, 1);
    assert.equal(first.messages[0]?.body, "");
    assert.equal(first.messages[0]?.attachments[0]?.filename, "release-notes.txt");
    assert.match(first.messages[0]?.attachments[0]?.previewUrl ?? "", new RegExp(`/api/meetings/${meeting.id}/attachments/`));
    assert.throws(() => attachments.remove(upload.id, "meeting-media-device"), { code: "attachment_in_use" });
    assert.throws(() => attachments.resolveDownload("orchestrator", meetingAttachmentOwnerId(other.id), upload.id), { code: "attachment_expired" });

    const retry = await f.agents.sendMeetingMessage(meeting.id, "", [upload.id], "meeting-media-device", requestId);
    assert.equal(retry.messages.filter(message => message.speakerType === "user").length, 1);
    await assert.rejects(f.agents.sendMeetingMessage(meeting.id, "", [upload.id], "meeting-media-device", randomUUID()),
      { code: "attachment_unavailable" });
    assert.equal(f.agents.meetingMessages(meeting.id).filter(message => message.speakerType === "user").length, 1,
      "A sent attachment cannot create an expired duplicate history entry");
    await assert.rejects(f.agents.sendMeetingMessage(meeting.id, "changed", [upload.id], "meeting-media-device", requestId),
      { code: "meeting_send_conflict" });
    const participantPrompt = f.requests().find(request => request.method === "turn/start")?.params.input[0].text as string;
    assert.match(participantPrompt, /The user attached files for review/);
    assert.match(participantPrompt, /release-notes\.txt/);
    assert.match(participantPrompt, new RegExp(upload.id));

    f.database.db.prepare("UPDATE attachment_uploads SET status='expired' WHERE id=?").run(upload.id);
    assert.equal(f.agents.meetingMessages(meeting.id)[0]?.attachments[0]?.status, "expired");
  } finally { f.close(); }
});

test("meeting attachment claims and identical request retries are atomic under concurrent sends", async () => {
  const f = coordinationFixture();
  try {
    const timestamp = new Date().toISOString();
    f.database.db.prepare(`INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at)
      VALUES ('meeting-race-device','Browser','',?,?)`).run(timestamp, timestamp);
    const member = f.agents.team.createMember({ name: "Sam", title: "Reviewer", instructions: "Review evidence." });
    const meeting = f.agents.team.createMeeting({ title: "Concurrent evidence", participantIds: [`member:${member.id}`] });
    const attachments = Reflect.get(f.agents, "attachments") as AttachmentService;
    const upload = attachments.initiate("orchestrator", meetingAttachmentOwnerId(meeting.id), "meeting-race-device",
      { filename: "evidence.txt", mediaType: "text/plain", size: 8 });
    attachments.appendChunk(upload.id, "meeting-race-device", 0, Buffer.from("evidence"));
    attachments.complete(upload.id, "meeting-race-device");

    const retryId = randomUUID();
    const identical = await Promise.all([
      f.agents.sendMeetingMessage(meeting.id, "", [upload.id], "meeting-race-device", retryId),
      f.agents.sendMeetingMessage(meeting.id, "", [upload.id], "meeting-race-device", retryId),
    ]);
    assert.equal(identical[0].messages.filter(message => message.clientRequestId === retryId).length, 1);
    assert.equal(identical[1].messages.filter(message => message.clientRequestId === retryId).length, 1);
    assert.equal((f.database.db.prepare("SELECT COUNT(*) AS count FROM meeting_messages WHERE meeting_id=? AND client_request_id=?")
      .get(meeting.id, retryId) as { count: number }).count, 1);

    const claimed = attachments.initiate("orchestrator", meetingAttachmentOwnerId(meeting.id), "meeting-race-device",
      { filename: "claim.txt", mediaType: "text/plain", size: 5 });
    attachments.appendChunk(claimed.id, "meeting-race-device", 0, Buffer.from("claim"));
    attachments.complete(claimed.id, "meeting-race-device");
    const competing = await Promise.allSettled([
      f.agents.sendMeetingMessage(meeting.id, "first", [claimed.id], "meeting-race-device", randomUUID()),
      f.agents.sendMeetingMessage(meeting.id, "second", [claimed.id], "meeting-race-device", randomUUID()),
    ]);
    assert.deepEqual(competing.map(result => result.status).sort(), ["fulfilled", "rejected"]);
    const failure = competing.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(failure?.reason?.code, "attachment_unavailable");
    const bound = f.database.db.prepare("SELECT meeting_message_id FROM attachment_uploads WHERE id=?").get(claimed.id) as { meeting_message_id: string };
    assert.ok(bound.meeting_message_id);
    assert.equal((f.database.db.prepare(`SELECT COUNT(*) AS count FROM meeting_messages
      WHERE meeting_id=? AND attachments_json LIKE ?`).get(meeting.id, `%${claimed.id}%`) as { count: number }).count, 1);
  } finally { f.close(); }
});

test("meeting composer source exposes attachment-only, microphone, retry, and accessible history behavior", () => {
  const source = readFileSync(new URL("../src/web/components/MeetingsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<AttachmentMenu disabled=/);
  assert.match(source, /useVoiceMessage\("meeting", id\)/);
  assert.match(source, /aria-label="Voice transcript"/);
  assert.match(source, /\(!text && !ready\.length\)/);
  assert.match(source, /attemptRef/);
  assert.match(source, /role="region" aria-label="Files to send"/);
  assert.match(source, /metadata: message\.attachments\.length \? \{ attachments: message\.attachments \}/);
});

test("meeting media HTTP routes require authentication and enforce meeting ownership", async () => {
  const f = coordinationFixture();
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro",
    dataDir: f.root, backupDir: `${f.root}/backups`, sessionDays: 365 };
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const stamp = new Date().toISOString();
    f.database.db.prepare(`INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at)
      VALUES ('http-meeting-device','Browser','',?,?)`).run(stamp, stamp);
    const token = new AuthService(f.database, 365).createSession("test", "local", "http-meeting-device").token;
    const headers = { authorization: `Bearer ${token}`, origin: config.publicBaseUrl };
    const participantIds = f.agents.team.availableParticipants().map(participant => `${participant.type}:${participant.id}`);
    const meeting = f.agents.team.createMeeting({ title: "HTTP files", participantIds });
    const other = f.agents.team.createMeeting({ title: "Wrong meeting", participantIds });
    app = await buildApp(config, f.database);
    const base = `/api/meetings/${meeting.id}`;
    assert.equal((await app.inject({ method: "POST", url: `${base}/attachments`, payload: { filename: "plan.txt", mediaType: "text/plain", size: 4 } })).statusCode, 401);
    const initiated = await app.inject({ method: "POST", url: `${base}/attachments`, headers,
      payload: { filename: "plan.txt", mediaType: "text/plain", size: 4 } });
    assert.equal(initiated.statusCode, 201, initiated.body);
    const attachmentId = initiated.json().attachment.id as string;
    await app.inject({ method: "PUT", url: `/api/attachments/${attachmentId}/chunks/0`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("plan") });
    await app.inject({ method: "POST", url: `/api/attachments/${attachmentId}/complete`, headers });
    assert.equal((await app.inject({ url: `/api/meetings/${other.id}/attachments/${attachmentId}`, headers })).statusCode, 410);
    const download = await app.inject({ url: `${base}/attachments/${attachmentId}`, headers });
    assert.equal(download.statusCode, 200, download.body);
    assert.equal(download.body, "plan");

    const requestId = randomUUID();
    const send = () => app!.inject({ method: "POST", url: `${base}/messages`, headers,
      payload: { message: "", attachmentIds: [attachmentId], requestId } });
    assert.equal((await send()).statusCode, 202);
    assert.equal((await send()).statusCode, 202);
    const count = f.database.db.prepare("SELECT COUNT(*) AS count FROM meeting_messages WHERE meeting_id=? AND client_request_id=?")
      .get(meeting.id, requestId) as { count: number };
    assert.equal(count.count, 1);
    const history = await app.inject({ url: base, headers });
    assert.equal(history.json().messages[0].attachments[0].filename, "plan.txt");
  } finally { if (app) await app.close(); f.close(); }
});
