import { randomUUID } from "node:crypto";
import { assertDomain } from "../domain/errors.js";
import type { ChatAttachment, MeetingMessage, MeetingParticipant, MeetingSummary, TeamMember, TeamMemberSession } from "../domain/types.js";
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
  speaker_name: string; speaker_title: string; body: string; attachments_json: string; client_request_id: string | null; created_at: string;
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
export type SupervisorProjectScope = {
  id: string;
  name: string;
  rootDirectory: string;
  allowedUrls: string[];
  recentTasks: Array<{ id: string; humanId: string; title: string; status: string; summary: string; artifacts: string[] }>;
};
export type SupervisorScope = {
  ownerId: string;
  meetingId: string | null;
  taskId: string | null;
  projects: SupervisorProjectScope[];
};
export type TeamManagementRequest = {
  id: string;
  meetingId: string;
  sourceMessageId: string;
  requesterType: MeetingParticipant["type"];
  requesterId: string;
  requesterName: string;
  requesterTitle: string;
  kind: "evidence" | "work" | "review";
  summary: string;
  projectId: string | null;
  taskId: string | null;
  status: "pending" | "delegated" | "awaiting_review" | "changes_requested" | "approved" | "failed";
  latestFeedback: string | null;
  reviewCount: number;
  createdAt: string;
  updatedAt: string;
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

function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].flatMap(match => {
    try {
      const url = new URL(match[0]!.replace(/[.,;:!?]+$/, ""));
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return [url.toString()];
    } catch { return []; }
  });
}

function safeContextText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/((?:authorization|api[_-]?key|token|password|secret|cookie|credential)\s*[:=]\s*)[^\s'";,]+/gi, "$1[redacted]");
}

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
  let attachments: ChatAttachment[] = [];
  try { attachments = JSON.parse(row.attachments_json || "[]") as ChatAttachment[]; } catch { /* Preserve the message if legacy metadata is malformed. */ }
  return { id: row.id, meetingId: row.meeting_id, speakerType: row.speaker_type, speakerId: row.speaker_id,
    speakerName: row.speaker_name, speakerTitle: row.speaker_title, body: row.body, attachments,
    ...(row.client_request_id ? { clientRequestId: row.client_request_id } : {}), ...(status ? { status } : {}), createdAt: row.created_at };
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

  supervisorScope(ownerId: string, currentText = ""): SupervisorScope {
    const sessionId = sessionIdFromOwner(ownerId);
    const meetingOwner = meetingOwnerParts(ownerId);
    const taskSession = sessionId ? this.database.db.prepare("SELECT task_id FROM team_member_sessions WHERE id=?")
      .get(sessionId) as { task_id: string | null } | undefined : undefined;
    const meetingText = meetingOwner ? this.messages(meetingOwner.meetingId).map(message => message.body).join("\n") : "";
    const ownerHistory = (this.database.db.prepare(`SELECT body FROM chat_messages WHERE owner_type='orchestrator' AND owner_id=?
      AND cancelled_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 24`).all(ownerId) as Array<{ body: string }>).map(row => row.body).join("\n");
    const context = `${meetingText}\n${ownerHistory}\n${currentText}`.normalize("NFKC").toLocaleLowerCase();
    const allProjects = this.database.db.prepare(`SELECT id,name,root_directory FROM projects
      WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE`).all() as Array<{ id: string; name: string; root_directory: string }>;
    const taskProject = taskSession?.task_id ? this.database.db.prepare(`SELECT p.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`)
      .get(taskSession.task_id) as { id: string } | undefined : undefined;
    const selected = allProjects.filter(project => project.id === taskProject?.id
      || context.includes(project.name.normalize("NFKC").toLocaleLowerCase()));
    const projects = selected.map(project => {
      const tasks = this.database.db.prepare(`SELECT id,human_id,title,status,description_text FROM tasks
        WHERE project_id=? ORDER BY updated_at DESC LIMIT 12`).all(project.id) as Array<{
          id: string; human_id: string; title: string; status: string; description_text: string;
        }>;
      const recentTasks = tasks.map(task => {
        const messages = this.database.db.prepare(`SELECT body FROM chat_messages WHERE owner_type='task' AND owner_id=?
          AND cancelled_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 8`).all(task.id) as Array<{ body: string }>;
        const outputs = this.database.db.prepare(`SELECT summary,artifacts_json FROM task_outputs WHERE task_id=?
          ORDER BY created_at DESC,rowid DESC LIMIT 3`).all(task.id) as Array<{ summary: string; artifacts_json: string }>;
        const artifactPaths = outputs.flatMap(output => {
          try {
            return (JSON.parse(output.artifacts_json) as Array<string | { path?: string }>).flatMap(item =>
              typeof item === "string" ? [item] : typeof item.path === "string" ? [item.path] : []);
          } catch { return []; }
        });
        return { id: task.id, humanId: task.human_id, title: task.title, status: task.status,
          summary: safeContextText(outputs[0]?.summary ?? messages[0]?.body.slice(0, 2_000) ?? task.description_text.slice(0, 2_000)), artifacts: artifactPaths.slice(0, 20) };
      });
      const urlText = [currentText, meetingText, ownerHistory, ...tasks.flatMap(task => {
        const rows = this.database.db.prepare(`SELECT body FROM chat_messages WHERE owner_type='task' AND owner_id=?
          AND body LIKE '%http%' ORDER BY created_at DESC,rowid DESC LIMIT 20`).all(task.id) as Array<{ body: string }>;
        return [task.description_text, ...rows.map(row => row.body)];
      })].join("\n");
      return { id: project.id, name: project.name, rootDirectory: project.root_directory,
        allowedUrls: [...new Set(urlsIn(urlText))].slice(0, 100), recentTasks };
    });
    return { ownerId, meetingId: meetingOwner?.meetingId ?? null, taskId: taskSession?.task_id ?? null, projects };
  }

  createManagementRequest(input: {
    meetingId: string; sourceMessageId: string; requester: MeetingParticipant;
    kind: TeamManagementRequest["kind"]; summary: string; projectId?: string | null; taskId?: string | null;
  }): TeamManagementRequest {
    this.getMeeting(input.meetingId);
    const summary = cleanText(input.summary, "Management request", 10_000);
    if (input.projectId) assertDomain(this.database.db.prepare("SELECT 1 FROM projects WHERE id=? AND archived_at IS NULL").get(input.projectId),
      "Project not found", "project_not_found", 404);
    if (input.taskId) assertDomain(this.database.db.prepare("SELECT 1 FROM tasks WHERE id=? OR human_id=?").get(input.taskId, input.taskId),
      "Task not found", "task_not_found", 404);
    let task: { id: string; project_id: string } | null = null;
    if (input.taskId) task = this.database.db.prepare("SELECT id,project_id FROM tasks WHERE id=? OR human_id=?")
      .get(input.taskId, input.taskId) as { id: string; project_id: string };
    const id = randomUUID(); const timestamp = now();
    this.database.db.prepare(`INSERT OR IGNORE INTO team_management_requests
      (id,meeting_id,source_message_id,requester_type,requester_id,requester_name,requester_title,kind,summary,project_id,task_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.meetingId, input.sourceMessageId, input.requester.type, input.requester.id,
        input.requester.name, input.requester.title, input.kind, summary, input.projectId ?? task?.project_id ?? null, task?.id ?? null, timestamp, timestamp);
    const row = this.database.db.prepare(`SELECT id FROM team_management_requests WHERE source_message_id=? AND requester_type=? AND requester_id=? AND summary=?`)
      .get(input.sourceMessageId, input.requester.type, input.requester.id, summary) as { id: string };
    return this.getManagementRequest(row.id);
  }

  managementRequests(statuses?: TeamManagementRequest["status"][]): TeamManagementRequest[] {
    const where = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    return (this.database.db.prepare(`SELECT * FROM team_management_requests ${where} ORDER BY updated_at,created_at`).all(...(statuses ?? [])) as any[])
      .map(row => this.managementRequestFromRow(row));
  }

  getManagementRequest(id: string): TeamManagementRequest {
    const row = this.database.db.prepare("SELECT * FROM team_management_requests WHERE id=?").get(id) as any;
    assertDomain(row, "Management request not found", "management_request_not_found", 404);
    return this.managementRequestFromRow(row);
  }

  delegateManagementRequest(id: string, taskId: string): TeamManagementRequest {
    const request = this.getManagementRequest(id);
    assertDomain(["pending", "changes_requested"].includes(request.status), "Management request is not ready for delegation", "management_request_state", 409);
    const task = this.database.db.prepare("SELECT id,project_id FROM tasks WHERE id=? OR human_id=?").get(taskId, taskId) as { id: string; project_id: string } | undefined;
    assertDomain(task, "Task not found", "task_not_found", 404);
    assertDomain(!request.projectId || request.projectId === task.project_id, "Task is outside the request project", "management_project_mismatch", 403);
    this.database.db.prepare(`UPDATE team_management_requests SET task_id=?,project_id=?,status='delegated',updated_at=? WHERE id=?`)
      .run(task.id, task.project_id, now(), id);
    return this.getManagementRequest(id);
  }

  markManagementReviewQueued(id: string): TeamManagementRequest {
    this.database.db.prepare(`UPDATE team_management_requests SET status='awaiting_review',updated_at=?
      WHERE id=? AND status IN ('delegated','changes_requested')`).run(now(), id);
    return this.getManagementRequest(id);
  }

  saveManagementReview(id: string, decision: "approved" | "changes_requested", feedback: string): TeamManagementRequest {
    this.database.db.prepare(`UPDATE team_management_requests SET status=?,latest_feedback=?,review_count=review_count+1,updated_at=?
      WHERE id=? AND status='awaiting_review'`).run(decision, feedback.slice(0, 20_000), now(), id);
    return this.getManagementRequest(id);
  }

  failManagementRequest(id: string, detail: string): TeamManagementRequest {
    this.database.db.prepare(`UPDATE team_management_requests SET status='failed',latest_feedback=?,updated_at=? WHERE id=?`)
      .run(detail.slice(0, 10_000), now(), id);
    return this.getManagementRequest(id);
  }

  private managementRequestFromRow(row: any): TeamManagementRequest {
    return { id: row.id, meetingId: row.meeting_id, sourceMessageId: row.source_message_id,
      requesterType: row.requester_type, requesterId: row.requester_id, requesterName: row.requester_name,
      requesterTitle: row.requester_title, kind: row.kind, summary: row.summary, projectId: row.project_id,
      taskId: row.task_id, status: row.status, latestFeedback: row.latest_feedback, reviewCount: row.review_count,
      createdAt: row.created_at, updatedAt: row.updated_at };
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

  addMeetingMessage(meetingId: string, speaker: Pick<MeetingMessage, "speakerType" | "speakerId" | "speakerName" | "speakerTitle">,
    body: string, attachments: ChatAttachment[] = [], clientRequestId?: string): string {
    const id = randomUUID(); const timestamp = now();
    this.database.db.prepare(`INSERT INTO meeting_messages
      (id,meeting_id,speaker_type,speaker_id,speaker_name,speaker_title,body,attachments_json,client_request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, meetingId, speaker.speakerType, speaker.speakerId, speaker.speakerName,
        speaker.speakerTitle, body, JSON.stringify(attachments), clientRequestId ?? null, timestamp);
    this.database.db.prepare("UPDATE meetings SET updated_at=? WHERE id=?").run(timestamp, meetingId);
    return id;
  }

  meetingMessageByRequest(meetingId: string, clientRequestId: string): MeetingMessage | null {
    const row = this.database.db.prepare("SELECT * FROM meeting_messages WHERE meeting_id=? AND client_request_id=?")
      .get(meetingId, clientRequestId) as MeetingMessageRow | undefined;
    return row ? meetingMessage(row, this.database) : null;
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
