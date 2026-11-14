import { ArrowLeft, Info, ListTodo, MessageCircle, Pause, Plus, Send, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMessage, TeamMember, TeamMemberSession, TaskWorkspace } from "../../domain/types";
import { api } from "../api";
import { MessageBody } from "./MessageBody";
import { RunningIndicator } from "./RunningIndicator";
import { TeamAvatar } from "./TeamAvatar";
import { UserAvatar } from "./UserAvatar";

type TeamRoute = { memberId: string | null; sessionId: string | null };

export function TeamPage({ connected, onError }: { connected: boolean; onError: (message: string) => void }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [route, setRoute] = useState<TeamRoute>(() => routeFromPath());
  const load = async () => setMembers((await api.team()).members);
  useEffect(() => { const pop = () => setRoute(routeFromPath()); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    const poll = async () => { try { const next = (await api.team()).members; if (!stopped) setMembers(next); }
      catch (error) { if (!stopped && !members.length) onError(error instanceof Error ? error.message : "Could not load team"); }
      if (!stopped) window.setTimeout(() => void poll(), 4000); };
    void poll(); return () => { stopped = true; };
  }, [connected]);
  const navigate = (next: TeamRoute) => {
    const path = next.memberId ? next.sessionId
      ? `/team/${encodeURIComponent(next.memberId)}/sessions/${encodeURIComponent(next.sessionId)}`
      : `/team/${encodeURIComponent(next.memberId)}` : "/team";
    history.pushState({}, "", path); setRoute(next);
  };
  const member = members.find(item => item.id === route.memberId);
  return <>
    <main className="unified-task-list team-list-page">
      <div className="workspace-intro"><span className="workspace-eyebrow">Supervisory perspectives</span><h1>Your team</h1><p>Each advisor keeps separate sessions for each task and for conversations you start.</p></div>
      <div className="section-heading"><div><h2>Team members</h2><p>Ask the orchestrator to add, edit, or remove a member.</p></div></div>
      <div className="task-rows team-rows">{members.map(item => <button className={`task-row conversation-row${item.unreadCount ? " is-unread" : ""}`} key={item.id} onClick={() => navigate({ memberId: item.id, sessionId: null })}>
        <TeamAvatar member={item} className="conversation-avatar" />
        <span className="conversation-copy"><span className="conversation-heading"><strong className="conversation-title">{item.name}</strong><RunningIndicator running={item.sessionState === "running"} label={`${item.name} running`} /></span>
          <span className="conversation-preview">{item.latestMessage ? <>{item.latestMessage.role === "user" && "You: "}{item.latestMessage.preview}</> : "No sessions yet"}</span>
          <span className="conversation-context"><span className="conversation-project">{item.title}</span><span className="conversation-status">Advisor</span></span></span>
        <span className="conversation-meta">{item.latestMessage && <time>{relativeTime(item.latestMessage.createdAt)}</time>}{item.unreadCount > 0 && <span className="conversation-unread">{item.unreadCount}</span>}</span>
      </button>)}</div>
      {!members.length && <div className="empty-state refined-empty"><span><UsersRound /></span><h2>No team members yet</h2><p>Tell the orchestrator the member’s name, professional title, and role instructions.</p></div>}
    </main>
    {member && !route.sessionId && <MemberSessions member={member} connected={connected} onBack={() => { navigate({ memberId: null, sessionId: null }); void load().catch(() => undefined); }} onOpen={sessionId => navigate({ memberId: member.id, sessionId })} onError={onError} />}
    {member && route.sessionId && <MemberChat member={member} sessionId={route.sessionId} connected={connected} onClose={() => navigate({ memberId: member.id, sessionId: null })} onError={onError} />}
  </>;
}

function MemberSessions({ member, connected, onBack, onOpen, onError }: { member: TeamMember; connected: boolean; onBack: () => void; onOpen: (id: string) => void; onError: (message: string) => void }) {
  const [sessions, setSessions] = useState<TeamMemberSession[]>([]);
  const [creating, setCreating] = useState(false);
  const load = async () => setSessions((await api.memberSessions(member.id)).sessions);
  useEffect(() => {
    if (!connected) return;
    let stopped = false; let timer = 0;
    const poll = async () => { try { const next = (await api.memberSessions(member.id)).sessions; if (!stopped) setSessions(next); }
      catch (error) { if (!stopped && !sessions.length) onError(error instanceof Error ? error.message : "Could not load member sessions"); }
      if (!stopped) timer = window.setTimeout(() => void poll(), 3000); };
    void poll(); return () => { stopped = true; window.clearTimeout(timer); };
  }, [connected, member.id]);
  return <section className="sheet-page member-sessions-page">
    <header className="sheet-header"><button className="icon-button" onClick={onBack} aria-label="Back to team"><ArrowLeft /></button><div><h1>{member.name}</h1><p>{member.title} · advisory sessions</p></div><button className="icon-button" onClick={() => setCreating(true)} aria-label="New session"><Plus /></button></header>
    <main className="project-list member-session-list">
      <div className="section-heading"><div><h2>Sessions</h2><p>Task interventions stay together in one session per task.</p></div><button className="primary" onClick={() => setCreating(true)}><Plus />New session</button></div>
      <div className="task-rows team-rows">{sessions.map(session => <button className={`task-row conversation-row${session.unreadCount ? " is-unread" : ""}`} key={session.id} onClick={() => onOpen(session.id)}>
        <span className={`member-session-icon ${session.kind}`}>{session.kind === "task" ? <ListTodo /> : <MessageCircle />}</span>
        <span className="conversation-copy"><span className="conversation-heading"><strong className="conversation-title">{session.title}</strong><RunningIndicator running={session.sessionState === "running"} label={`${session.title} running`} /></span>
          <span className="conversation-preview">{session.latestMessage ? <>{session.latestMessage.role === "user" && "You: "}{session.latestMessage.preview}</> : session.kind === "task" ? "Waiting for the first task intervention" : "No messages yet"}</span>
          <span className="conversation-context"><span className="conversation-project">{session.kind === "task" ? session.taskHumanId : "Manual session"}</span><span className="conversation-status">{session.kind === "task" ? "Task advice" : "Advisory chat"}</span></span></span>
        <span className="conversation-meta">{session.latestMessage && <time>{relativeTime(session.latestMessage.createdAt)}</time>}{session.unreadCount > 0 && <span className="conversation-unread">{session.unreadCount}</span>}</span>
      </button>)}</div>
      {!sessions.length && <div className="empty-state refined-empty"><span><MessageCircle /></span><h2>No sessions yet</h2><p>Start an advisory conversation. Task interventions will appear here automatically.</p><button className="primary" onClick={() => setCreating(true)}><Plus />New session</button></div>}
    </main>
    {creating && <NewSessionModal member={member} onClose={() => setCreating(false)} onCreated={session => { setCreating(false); void load(); onOpen(session.id); }} onError={onError} />}
  </section>;
}

function NewSessionModal({ member, onClose, onCreated, onError }: { member: TeamMember; onClose: () => void; onCreated: (session: TeamMemberSession) => void; onError: (message: string) => void }) {
  const [title, setTitle] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!title.trim() || saving) return; setSaving(true);
    try { onCreated((await api.createMemberSession(member.id, title.trim())).session); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not create session"); setSaving(false); } };
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="form-modal member-session-create" onSubmit={submit}>
    <div className="form-heading"><div><h2>New session with {member.name}</h2><p>Create a separate advisory conversation.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
    <label>Session title<input autoFocus maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Release strategy" /></label>
    <div className="button-row"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!title.trim() || saving}>{saving ? "Creating…" : "Create session"}</button></div>
  </form></div>;
}

function MemberChat({ member, sessionId, connected, onClose, onError }: { member: TeamMember; sessionId: string; connected: boolean; onClose: () => void; onError: (message: string) => void }) {
  const [workspace, setWorkspace] = useState<TaskWorkspace | null>(null);
  const [sessions, setSessions] = useState<TeamMemberSession[]>([]);
  const [message, setMessage] = useState(() => localStorage.getItem(`qahwa-team-session-draft:${sessionId}`) ?? "");
  const [sending, setSending] = useState(false); const stream = useRef<HTMLDivElement>(null);
  const session = sessions.find(item => item.id === sessionId);
  useEffect(() => { localStorage.setItem(`qahwa-team-session-draft:${sessionId}`, message); }, [sessionId, message]);
  useEffect(() => {
    if (!connected) return;
    let stopped = false; let timer = 0;
    const poll = async () => { try {
      const [workspaceResult, sessionsResult] = await Promise.all([api.memberSessionWorkspace(member.id, sessionId), api.memberSessions(member.id)]);
      if (!stopped) { setWorkspace(workspaceResult.workspace); setSessions(sessionsResult.sessions); const unread = workspaceResult.workspace.messages.filter(item => item.role === "assistant").map(item => item.id); if (unread.length) void api.markMemberSessionRead(member.id, sessionId, unread).catch(() => undefined); }
    } catch (error) { if (!stopped && !workspace) onError(error instanceof Error ? error.message : "Could not load member session"); }
      if (!stopped) timer = window.setTimeout(() => void poll(), 1600); };
    void poll(); return () => { stopped = true; window.clearTimeout(timer); };
  }, [connected, member.id, sessionId]);
  useEffect(() => { if (stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [workspace?.messages.length]);
  const submit = async (event: FormEvent) => { event.preventDefault(); const text = message.trim(); if (!text || sending || !connected) return;
    setSending(true); try { setWorkspace((await api.sendMemberSessionMessage(member.id, sessionId, text)).workspace); setMessage(""); localStorage.removeItem(`qahwa-team-session-draft:${sessionId}`); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not send message"); } finally { setSending(false); } };
  return <section className="chat-session orchestrator-page member-page">
    <header className="session-header"><button className="icon-button" onClick={onClose} aria-label={`Back to ${member.name}'s sessions`}><ArrowLeft /></button><TeamAvatar member={member} className="session-avatar" />
      <div className="session-title"><span>{session?.title ?? member.name}</span><strong>{member.name} · {member.title}</strong><small>{session?.kind === "task" ? `${session.taskHumanId} · task advice` : "Advisory session"} · {workspace?.session.runState ?? session?.sessionState ?? "not_started"}</small></div>
      {(workspace?.session.runState === "running" || workspace?.session.runState === "waiting") && <button className="icon-button warning" onClick={() => void api.interruptMemberSession(member.id, sessionId).catch(error => onError(error.message))} aria-label="Interrupt"><Pause /></button>}
    </header>
    <div className="chat-workspace"><div className="chat-stream" ref={stream}><div className="chat-history">{workspace?.messages.map(entry => <MemberMessage key={entry.id} entry={entry} member={member} />)}
      {workspace?.messages.length === 0 && <div className="session-empty"><span className="empty-orb"><TeamAvatar member={member} /></span><span className="empty-kicker">{session?.kind === "task" ? "Task advisory history" : "Advisory conversation"}</span><h2>{session?.title ?? `Talk with ${member.name}`}</h2><p>{member.instructions}</p></div>}<div /></div></div>
      <form className="chat-composer" onSubmit={submit}><div className="composer-field"><textarea className="composer-message" rows={1} value={message} onChange={event => setMessage(event.target.value)} placeholder={`Message ${member.name}`} /><button className="send-button" type="submit" disabled={!connected || sending || !message.trim()} aria-label="Send"><Send /></button></div></form>
    </div>
  </section>;
}

function MemberMessage({ entry, member }: { entry: ChatMessage; member: TeamMember }) {
  if (entry.role === "system") return <article className="chat-message system"><details className="system-message"><summary className="system-message-summary"><Info /><span className="system-message-preview">{entry.body.split("\n", 1)[0]}</span><time>{time(entry.createdAt)}</time></summary><div className="system-message-body"><MessageBody entry={entry} /></div></details></article>;
  return <article className={`chat-message ${entry.role}`}><span className="message-avatar">{entry.role === "assistant" ? <TeamAvatar member={member} /> : <UserAvatar />}</span><div className="message-content"><div className="message-role"><div className="message-metadata"><span className="message-sender">{entry.role === "assistant" ? member.name : "You"}</span><time>{time(entry.createdAt)}</time>{entry.pending && <span className="message-pending">Pending</span>}</div></div><MessageBody entry={entry} /></div></article>;
}

const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000)); return minutes < 1 ? "Now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
function routeFromPath(): TeamRoute { const match = /^\/team\/([^/]+)(?:\/sessions\/([^/]+))?$/.exec(location.pathname); return match ? { memberId: decodeURIComponent(match[1]!), sessionId: match[2] ? decodeURIComponent(match[2]) : null } : { memberId: null, sessionId: null }; }
