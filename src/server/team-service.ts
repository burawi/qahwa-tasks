import { randomUUID } from "node:crypto";
import { assertDomain } from "../domain/errors.js";
import type { MeetingMessage, MeetingParticipant, MeetingSummary, TeamMember, TeamMemberSession } from "../domain/types.js";
import type { UserAvatar } from "../domain/user-avatar.js";
import { MAX_USER_AVATAR_BYTES, USER_AVATAR_SIZE_ERROR } from "../domain/user-avatar.js";
import type { AppDatabase } from "./database.js";
import { detectUploadedImage } from "./image-upload.js";
import { getOrchestratorAvatar } from "./orchestrator-avatar.js";
import { getOrchestratorSettings } from "./orchestrator-settings.js";

type MemberRow = {
  id: string; name: string; title: string; instructions: string;
  avatar_mime_type: UserAvatar["mimeType"] | null; avatar_size: number | null; avatar_version: string | null;
  archived_at: string | null; created_at: string; updated_at: string;
};

type MeetingRow = { id: string; title: string; status: "active" | "archived"; created_at: string; updated_at: string };
type MeetingMessageRow = {
  id: string; meeting_id: string; speaker_type: MeetingMessage["speakerType"]; speaker_id: string | null;
  speaker_name: string; speaker_title: string; body: string; created_at: string;
};
export type OrchestratorMeetingAccess = {
  requested: boolean;
  scope: "active" | "archived";
  resolution: "not_requested" | "listing" | "resolved" | "none" | "ambiguous" | "not_found";
  activeMeetings: Array<Pick<MeetingSummary, "id" | "title" | "status" | "createdAt" | "updatedAt">>;
  archivedMeetings?: Array<Pick<MeetingSummary, "id" | "title" | "status" | "createdAt" | "updatedAt">>;
  candidates?: Array<Pick<MeetingSummary, "id" | "title" | "status">>;
  meeting?: { id: string; title: string; status: MeetingSummary["status"]; participants: MeetingParticipant[]; transcript: MeetingMessage[] };
};
type MemberSessionRow = {
  id: string; member_id: string; kind: TeamMemberSession["kind"]; task_id: string | null; title: string;
  archived_at: string | null; created_at: string; updated_at: string;
  task_human_id?: string | null; task_title?: string | null;
};

const now = () => new Date().toISOString();
export const memberSessionOwnerId = (id: string) => `team-session:${id}`;
export const meetingParticipantOwnerId = (meetingId: string, participant: Pick<MeetingParticipant, "type" | "id">) =>
  `team-meeting:${meetingId}:${participant.type}:${participant.id}`;
const sessionIdFromOwner = (ownerId: string) => ownerId.startsWith("team-session:") ? ownerId.slice("team-session:".length) : null;
const meetingOwnerParts = (ownerId: string) => {
  const match = /^team-meeting:([^:]+):(orchestrator|member):(.+)$/.exec(ownerId);
  return match ? { meetingId: match[1]!, type: match[2]! as MeetingParticipant["type"], id: match[3]! } : null;
};

function cleanText(value: unknown, label: string, maximum: number): string {
  assertDomain(typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum,
    `${label} is required and must be at most ${maximum} characters`, `invalid_${label.toLowerCase().replaceAll(" ", "_")}`);
  return value.trim();
}

function avatarFromRow(row: MemberRow): UserAvatar | null {
  return row.avatar_mime_type && row.avatar_size && row.avatar_version
    ? { mimeType: row.avatar_mime_type, size: row.avatar_size, version: row.avatar_version,
      url: `/api/team/${encodeURIComponent(row.id)}/avatar/image?v=${row.avatar_version}` }
    : null;
}

function meetingMessage(row: MeetingMessageRow, database: AppDatabase): MeetingMessage {
  const dispatch = database.db.prepare(`SELECT COUNT(*) AS total,
    SUM(status='pending') AS pending, SUM(status='failed') AS failed FROM team_dispatches WHERE source_message_id=?`)
    .get(row.id) as { total: number; pending: number; failed: number };
  const status = row.speaker_type === "user" && dispatch.total
    ? dispatch.pending ? "pending" : dispatch.failed ? "failed" : "delivered"
    : undefined;
  return { id: row.id, meetingId: row.meeting_id, speakerType: row.speaker_type, speakerId: row.speaker_id,
    speakerName: row.speaker_name, speakerTitle: row.speaker_title, body: row.body, ...(status ? { status } : {}), createdAt: row.created_at };
}

export class TeamService {
  constructor(private readonly database: AppDatabase) {}

  listMembers(includeArchived = false): TeamMember[] {
    const rows = this.database.db.prepare(`SELECT * FROM team_members ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY name COLLATE NOCASE`)
      .all() as MemberRow[];
    return rows.map(row => {
      const session = this.database.db.prepare(`SELECT a.run_state FROM agent_sessions a JOIN team_member_sessions s
        ON a.owner_type='orchestrator' AND a.owner_id='team-session:' || s.id
        WHERE s.member_id=? AND s.archived_at IS NULL
        ORDER BY CASE a.run_state WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,a.updated_at DESC LIMIT 1`)
        .get(row.id) as { run_state: TeamMember["sessionState"] } | undefined;
      const latest = this.database.db.prepare(`SELECT role,body,created_at FROM chat_messages
        WHERE owner_type='orchestrator' AND owner_id IN (
          SELECT 'team-session:' || id FROM team_member_sessions WHERE member_id=? AND archived_at IS NULL
        ) AND role IN ('user','assistant') AND cancelled_at IS NULL
        ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(row.id) as { role: "user" | "assistant"; body: string; created_at: string } | undefined;
      const unread = this.database.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages m LEFT JOIN chat_message_reads r ON r.message_id=m.id
        WHERE m.owner_type='orchestrator' AND m.owner_id IN (
          SELECT 'team-session:' || id FROM team_member_sessions WHERE member_id=? AND archived_at IS NULL
        ) AND m.role='assistant' AND r.message_id IS NULL`).get(row.id) as { count: number };
      return { id: row.id, name: row.name, title: row.title, instructions: row.instructions, avatar: avatarFromRow(row),
        sessionState: session?.run_state ?? "not_started", unreadCount: unread.count,
        latestMessage: latest ? { preview: latest.body.replace(/\s+/g, " ").slice(0, 180), role: latest.role, createdAt: latest.created_at } : null,
        createdAt: row.created_at, updatedAt: row.updated_at };
    });
  }

  getMember(id: string, allowArchived = false): TeamMember {
    const member = this.listMembers(allowArchived).find(member => member.id === id);
    assertDomain(member, "Team member not found", "team_member_not_found", 404);
    return member;
  }

  createManualSession(memberId: string, input: { title?: unknown }): TeamMemberSession {
    this.getMember(memberId);
    const title = cleanText(input?.title, "Session title", 160);
    const id = randomUUID(); const timestamp = now();
    this.database.db.prepare(`INSERT INTO team_member_sessions(id,member_id,kind,title,created_at,updated_at)
      VALUES (?,?,'manual',?,?,?)`).run(id, memberId, title, timestamp, timestamp);
    return this.getMemberSession(memberId, id);
  }

  ensureTaskSession(memberId: string, taskId: string): TeamMemberSession {
    this.getMember(memberId);
    const task = this.database.db.prepare("SELECT id,human_id,title FROM tasks WHERE id=? OR human_id=?")
      .get(taskId, taskId) as { id: string; human_id: string; title: string } | undefined;
    assertDomain(task, "Task not found", "task_not_found", 404);
    const existing = this.database.db.prepare("SELECT id FROM team_member_sessions WHERE member_id=? AND task_id=?")
      .get(memberId, task.id) as { id: string } | undefined;
    if (existing) {
      this.database.db.prepare("UPDATE team_member_sessions SET title=?,updated_at=? WHERE id=?").run(task.title, now(), existing.id);
      return this.getMemberSession(memberId, existing.id);
    }
    const id = randomUUID(); const timestamp = now();
    this.database.db.prepare(`INSERT INTO team_member_sessions(id,member_id,kind,task_id,title,created_at,updated_at)
      VALUES (?,?,'task',?,?,?,?)`).run(id, memberId, task.id, task.title, timestamp, timestamp);
    return this.getMemberSession(memberId, id);
  }

  listMemberSessions(memberId: string): TeamMemberSession[] {
    this.getMember(memberId, true);
    const rows = this.database.db.prepare(`SELECT s.*,t.human_id AS task_human_id,t.title AS task_title
      FROM team_member_sessions s LEFT JOIN tasks t ON t.id=s.task_id
      WHERE s.member_id=? AND s.archived_at IS NULL
      ORDER BY COALESCE((SELECT MAX(m.created_at) FROM chat_messages m
        WHERE m.owner_type='orchestrator' AND m.owner_id='team-session:' || s.id),s.updated_at) DESC,s.created_at DESC`).all(memberId) as MemberSessionRow[];
    return rows.map(row => this.memberSessionFromRow(row));
  }

  getMemberSession(memberId: string, sessionId: string): TeamMemberSession {
    const row = this.database.db.prepare(`SELECT s.*,t.human_id AS task_human_id,t.title AS task_title
      FROM team_member_sessions s LEFT JOIN tasks t ON t.id=s.task_id
      WHERE s.id=? AND s.member_id=? AND s.archived_at IS NULL`).get(sessionId, memberId) as MemberSessionRow | undefined;
    assertDomain(row, "Team member session not found", "team_member_session_not_found", 404);
    return this.memberSessionFromRow(row);
  }

  memberForOwner(ownerId: string): TeamMember | null {
    const sessionId = sessionIdFromOwner(ownerId);
    if (sessionId) {
      const row = this.database.db.prepare("SELECT member_id FROM team_member_sessions WHERE id=?").get(sessionId) as { member_id: string } | undefined;
      return row ? this.getMember(row.member_id, true) : null;
    }
    const meetingOwner = meetingOwnerParts(ownerId);
    if (meetingOwner?.type === "member") return this.getMember(meetingOwner.id, true);
    return null;
  }

  participantForOwner(ownerId: string): MeetingParticipant | null {
    const member = this.memberForOwner(ownerId);
    if (member) return this.participant(member);
    const meetingOwner = meetingOwnerParts(ownerId);
    if (!meetingOwner) return null;
    return this.getMeeting(meetingOwner.meetingId).participants.find(participant =>
      participant.type === meetingOwner.type && participant.id === meetingOwner.id) ?? null;
  }

  private memberSessionFromRow(row: MemberSessionRow): TeamMemberSession {
    const ownerId = memberSessionOwnerId(row.id);
    const agent = this.database.db.prepare("SELECT run_state FROM agent_sessions WHERE owner_type='orchestrator' AND owner_id=?")
      .get(ownerId) as { run_state: TeamMemberSession["sessionState"] } | undefined;
    const latest = this.database.db.prepare(`SELECT role,body,created_at FROM chat_messages
      WHERE owner_type='orchestrator' AND owner_id=? AND role IN ('user','assistant') AND cancelled_at IS NULL
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(ownerId) as { role: "user" | "assistant"; body: string; created_at: string } | undefined;
    const unread = this.database.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages m LEFT JOIN chat_message_reads r ON r.message_id=m.id
      WHERE m.owner_type='orchestrator' AND m.owner_id=? AND m.role='assistant' AND r.message_id IS NULL`).get(ownerId) as { count: number };
    return { id: row.id, memberId: row.member_id, kind: row.kind, taskId: row.task_id,
      taskHumanId: row.task_human_id ?? null, taskTitle: row.task_title ?? null, title: row.title,
      sessionState: agent?.run_state ?? "not_started", unreadCount: unread.count,
      latestMessage: latest ? { preview: latest.body.replace(/\s+/g, " ").slice(0, 180), role: latest.role, createdAt: latest.created_at } : null,
      createdAt: row.created_at, updatedAt: latest?.created_at ?? row.updated_at };
  }

  createMember(input: { name?: unknown; title?: unknown; instructions?: unknown }): TeamMember {
    const name = cleanText(input?.name, "Name", 80);
    const title = cleanText(input?.title, "Title", 120);
    const instructions = cleanText(input?.instructions, "Instructions", 10_000);
    assertDomain(name.toLocaleLowerCase() !== getOrchestratorSettings(this.database).name.toLocaleLowerCase(),
      "A member name must be different from the orchestrator name", "duplicate_participant_name");
    const id = randomUUID(); const timestamp = now();
    try {
      this.database.db.prepare(`INSERT INTO team_members(id,name,title,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
        .run(id, name, title, instructions, timestamp, timestamp);
    } catch (error) {
      if (String(error).includes("UNIQUE")) assertDomain(false, "Team member names must be unique", "duplicate_team_member", 409);
      throw error;
    }
    return this.getMember(id);
  }

  updateMember(id: string, input: { name?: unknown; title?: unknown; instructions?: unknown }): TeamMember {
    const current = this.getMember(id);
    const name = input.name === undefined ? current.name : cleanText(input.name, "Name", 80);
    const title = input.title === undefined ? current.title : cleanText(input.title, "Title", 120);
    const instructions = input.instructions === undefined ? current.instructions : cleanText(input.instructions, "Instructions", 10_000);
    assertDomain(name.toLocaleLowerCase() !== getOrchestratorSettings(this.database).name.toLocaleLowerCase(),
      "A member name must be different from the orchestrator name", "duplicate_participant_name");
    try { this.database.db.prepare("UPDATE team_members SET name=?,title=?,instructions=?,updated_at=? WHERE id=? AND archived_at IS NULL")
      .run(name, title, instructions, now(), id); }
    catch (error) {
      if (String(error).includes("UNIQUE")) assertDomain(false, "Team member names must be unique", "duplicate_team_member", 409);
      throw error;
    }
    return this.getMember(id);
  }

  archiveMember(id: string): TeamMember {
    const member = this.getMember(id);
    const timestamp = now();
    this.database.db.prepare("UPDATE team_members SET archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL").run(timestamp, timestamp, id);
    return { ...member, updatedAt: timestamp };
  }

  saveAvatar(id: string, bytes: Buffer, declaredMimeType: string): TeamMember {
    this.getMember(id);
    assertDomain(bytes.length > 0, "Avatar file is empty", "empty_team_avatar");
    assertDomain(bytes.length <= MAX_USER_AVATAR_BYTES, USER_AVATAR_SIZE_ERROR, "team_avatar_too_large", 413);
    const detected = detectUploadedImage(bytes);
    assertDomain(detected, "Avatar must be a PNG, JPEG, or WebP image", "invalid_team_avatar_type");
    assertDomain(declaredMimeType.toLowerCase() === detected.mimeType, "Avatar content does not match its file type", "team_avatar_type_mismatch");
    this.database.db.prepare(`UPDATE team_members SET avatar_mime_type=?,avatar_size=?,avatar_version=?,avatar_data=?,updated_at=? WHERE id=?`)
      .run(detected.mimeType, bytes.length, randomUUID(), bytes.toString("base64"), now(), id);
    return this.getMember(id);
  }

  avatarImage(id: string): { bytes: Buffer; mimeType: UserAvatar["mimeType"] } {
    const row = this.database.db.prepare("SELECT avatar_mime_type,avatar_data FROM team_members WHERE id=?")
      .get(id) as { avatar_mime_type: UserAvatar["mimeType"] | null; avatar_data: string | null } | undefined;
    assertDomain(row?.avatar_mime_type && row.avatar_data, "Team member avatar not found", "team_avatar_not_found", 404);
    return { bytes: Buffer.from(row.avatar_data, "base64"), mimeType: row.avatar_mime_type };
  }

  participant(member: TeamMember): MeetingParticipant {
    return { type: "member", id: member.id, name: member.name, title: member.title, avatar: member.avatar };
  }

  orchestratorParticipant(): MeetingParticipant {
    const settings = getOrchestratorSettings(this.database);
    return { type: "orchestrator", id: "main", name: settings.name, title: "Orchestrator", avatar: getOrchestratorAvatar(this.database) };
  }

  availableParticipants(): MeetingParticipant[] { return [this.orchestratorParticipant(), ...this.listMembers().map(member => this.participant(member))]; }

  createMeeting(input: { title?: unknown; participantIds?: unknown }): MeetingSummary {
    const title = cleanText(input?.title, "Meeting title", 160);
    assertDomain(Array.isArray(input?.participantIds) && input.participantIds.length > 0
      && input.participantIds.every(id => typeof id === "string"), "Select at least one participant", "invalid_meeting_participants");
    const available = new Map(this.availableParticipants().map(participant => [`${participant.type}:${participant.id}`, participant]));
    const selected = [...new Set(input.participantIds as string[])].map(key => available.get(key));
    assertDomain(selected.every(Boolean), "One or more meeting participants are unavailable", "invalid_meeting_participants");
    const id = randomUUID(); const timestamp = now();
    this.database.db.transaction(() => {
      this.database.db.prepare("INSERT INTO meetings(id,title,created_at,updated_at) VALUES (?,?,?,?)").run(id, title, timestamp, timestamp);
      const insert = this.database.db.prepare(`INSERT INTO meeting_participants
        (meeting_id,participant_type,participant_id,name_snapshot,title_snapshot,avatar_snapshot_json) VALUES (?,?,?,?,?,?)`);
      for (const participant of selected as MeetingParticipant[]) insert.run(id, participant.type, participant.id, participant.name, participant.title,
        participant.avatar ? JSON.stringify(participant.avatar) : null);
    })();
    return this.getMeeting(id);
  }

  listMeetings(includeArchived = false): MeetingSummary[] {
    const rows = this.database.db.prepare(`SELECT * FROM meetings ${includeArchived ? "" : "WHERE status='active'"} ORDER BY updated_at DESC`).all() as MeetingRow[];
    return rows.map(row => this.meetingFromRow(row));
  }

  /** Read-only context available only to the authenticated orchestrator session. */
  orchestratorMeetingAccess(query: string): OrchestratorMeetingAccess {
    const active = this.listMeetings();
    const all = this.listMeetings(true);
    const archived = all.filter(meeting => meeting.status === "archived");
    const directory = (meeting: MeetingSummary) => ({ id: meeting.id, title: meeting.title, status: meeting.status,
      createdAt: meeting.createdAt, updatedAt: meeting.updatedAt });
    const candidate = (meeting: MeetingSummary) => ({ id: meeting.id, title: meeting.title, status: meeting.status });
    const normalized = query.normalize("NFKC").toLocaleLowerCase();
    const archivedRequested = /\b(?:archived|historical)\b/u.test(normalized);
    const scope = archivedRequested ? archived : active;
    const titleMatches = scope.filter(meeting => {
      const title = meeting.title.normalize("NFKC").toLocaleLowerCase();
      return normalized.includes(meeting.id.toLocaleLowerCase()) || (title.length > 1 && normalized.includes(title));
    });
    const singularReference = /\b(?:the|this|current|active|archived|historical)\s+meeting\b|\bmeeting(?:'s)?\s+(?:participants?|status|transcript|discussion)\b/u.test(normalized);
    const meetingLanguage = /\bmeetings?\b|\bparticipants?\b|\btranscript\b|\bdiscussion\b/u.test(normalized) || titleMatches.length > 0;
    const listing = /\b(?:list|show|which|what|any)\b[^.?!]*\bmeetings?\b|\bmeetings?\s+(?:list|available)\b/u.test(normalized);
    const base: OrchestratorMeetingAccess = { requested: meetingLanguage, scope: archivedRequested ? "archived" : "active",
      resolution: meetingLanguage ? "listing" : "not_requested", activeMeetings: active.map(directory),
      ...(archivedRequested ? { archivedMeetings: archived.map(directory) } : {}) };
    const resolved = (meeting: MeetingSummary): OrchestratorMeetingAccess => ({ ...base, requested: true, resolution: "resolved",
      meeting: { id: meeting.id, title: meeting.title, status: meeting.status, participants: meeting.participants, transcript: this.messages(meeting.id) } });
    if (titleMatches.length === 1) return resolved(titleMatches[0]!);
    if (titleMatches.length > 1) return { ...base, resolution: "ambiguous", candidates: titleMatches.map(candidate) };
    if (singularReference) {
      if (scope.length === 1) return resolved(scope[0]!);
      if (scope.length === 0) return { ...base, resolution: "none", candidates: [] };
      return { ...base, resolution: "ambiguous", candidates: scope.map(candidate) };
    }
    if (listing) return base;
    if (meetingLanguage && archivedRequested && archived.length === 0) return { ...base, resolution: "none", candidates: [] };
    if (meetingLanguage && /\b(?:read|open|details?|status|participants?|transcript)\b/u.test(normalized)) {
      return { ...base, resolution: "not_found", candidates: scope.map(candidate) };
    }
    return base;
  }

  getMeeting(id: string): MeetingSummary {
    const row = this.database.db.prepare("SELECT * FROM meetings WHERE id=?").get(id) as MeetingRow | undefined;
    assertDomain(row, "Meeting not found", "meeting_not_found", 404);
    return this.meetingFromRow(row);
  }

  archiveMeeting(id: string): MeetingSummary {
    const meeting = this.getMeeting(id);
    if (meeting.status === "active") this.database.db.prepare("UPDATE meetings SET status='archived',updated_at=? WHERE id=?").run(now(), id);
    return this.getMeeting(id);
  }

  private meetingFromRow(row: MeetingRow): MeetingSummary {
    const participants = (this.database.db.prepare(`SELECT participant_type,participant_id,name_snapshot,title_snapshot,avatar_snapshot_json
      FROM meeting_participants WHERE meeting_id=? ORDER BY rowid`).all(row.id) as Array<{
        participant_type: MeetingParticipant["type"]; participant_id: string; name_snapshot: string; title_snapshot: string; avatar_snapshot_json: string | null;
      }>).map(item => ({ type: item.participant_type, id: item.participant_id, name: item.name_snapshot, title: item.title_snapshot,
        avatar: item.avatar_snapshot_json ? JSON.parse(item.avatar_snapshot_json) as UserAvatar : null }));
    const latest = this.database.db.prepare("SELECT * FROM meeting_messages WHERE meeting_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .get(row.id) as MeetingMessageRow | undefined;
    return { id: row.id, title: row.title, status: row.status, participants, latestMessage: latest ? meetingMessage(latest, this.database) : null,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  messages(meetingId: string): MeetingMessage[] {
    this.getMeeting(meetingId);
    return (this.database.db.prepare("SELECT * FROM meeting_messages WHERE meeting_id=? ORDER BY created_at,rowid").all(meetingId) as MeetingMessageRow[])
      .map(row => meetingMessage(row, this.database));
  }

  addMeetingMessage(meetingId: string, speaker: Pick<MeetingMessage, "speakerType" | "speakerId" | "speakerName" | "speakerTitle">, body: string): string {
    const id = randomUUID(); const timestamp = now();
    this.database.db.prepare(`INSERT INTO meeting_messages(id,meeting_id,speaker_type,speaker_id,speaker_name,speaker_title,body,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, meetingId, speaker.speakerType, speaker.speakerId, speaker.speakerName, speaker.speakerTitle, body, timestamp);
    this.database.db.prepare("UPDATE meetings SET updated_at=? WHERE id=?").run(timestamp, meetingId);
    return id;
  }

  participantsForMessage(meetingId: string, body: string): MeetingParticipant[] {
    const meeting = this.getMeeting(meetingId);
    const mentioned = meeting.participants.filter(participant => new RegExp(`(^|[^\\p{L}\\p{N}_])@${participant.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(body));
    return mentioned.length ? mentioned : meeting.participants;
  }

  createDispatch(sourceMessageId: string, sourceType: "meeting" | "task", sourceId: string, participant: MeetingParticipant): string {
    const id = randomUUID(); const timestamp = now();
    this.database.db.prepare(`INSERT INTO team_dispatches(id,source_message_id,source_type,source_id,participant_type,participant_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, sourceMessageId, sourceType, sourceId, participant.type, participant.id, timestamp, timestamp);
    return id;
  }

  completeDispatch(id: string, responseMessageId: string): void {
    this.database.db.prepare("UPDATE team_dispatches SET status='delivered',response_message_id=?,updated_at=? WHERE id=?")
      .run(responseMessageId, now(), id);
  }

  failDispatch(id: string, error: string): void {
    this.database.db.prepare("UPDATE team_dispatches SET status='failed',error=?,updated_at=? WHERE id=?")
      .run(error.slice(0, 1000), now(), id);
  }
}
