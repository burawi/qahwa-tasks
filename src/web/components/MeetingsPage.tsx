import { Archive, ArrowLeft, CalendarPlus, MessagesSquare, Plus, Send, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MeetingMessage, MeetingParticipant, MeetingSummary } from "../../domain/types";
import { api } from "../api";
import { MessageBody } from "./MessageBody";
import { OrchestratorAvatar } from "./OrchestratorAvatar";
import { TeamAvatar } from "./TeamAvatar";
import { UserAvatar } from "./UserAvatar";
import { ActionDialog } from "./ActionDialog";

export function MeetingsPage({ connected, onError }: { connected: boolean; onError: (message: string) => void }) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => meetingFromPath());
  const [creating, setCreating] = useState(false);
  const load = async () => setMeetings((await api.meetings()).meetings);
  useEffect(() => { if (!connected) return; let stopped = false; let timer = 0; const poll = async () => {
    try { const next = (await api.meetings()).meetings; if (!stopped) setMeetings(next); } catch (error) { if (!stopped && !meetings.length) onError(error instanceof Error ? error.message : "Could not load meetings"); }
    if (!stopped) timer = window.setTimeout(() => void poll(), 4000); }; void poll(); return () => { stopped = true; window.clearTimeout(timer); }; }, [connected]);
  const open = (meeting: MeetingSummary) => { history.pushState({}, "", `/meetings/${meeting.id}`); setSelected(meeting.id); };
  const close = () => { history.pushState({}, "", "/meetings"); setSelected(null); void load().catch(() => undefined); };
  return <>
    <main className="unified-task-list meetings-list-page"><div className="workspace-intro"><span className="workspace-eyebrow">Think together</span><h1>Meetings</h1><p>Durable, ad hoc discussions with the orchestrator and your selected team.</p></div>
      <div className="section-heading"><div><h2>Active meetings</h2><p>Open messages go to everyone; @mentions address specific participants.</p></div><button className="primary" onClick={() => setCreating(true)}><Plus />New meeting</button></div>
      <div className="task-rows meeting-rows">{meetings.map(meeting => <button className="task-row conversation-row" key={meeting.id} onClick={() => open(meeting)}>
        <span className="meeting-list-avatar"><MessagesSquare /></span><span className="conversation-copy"><strong className="conversation-title">{meeting.title}</strong><span className="conversation-preview">{meeting.latestMessage ? `${meeting.latestMessage.speakerName}: ${meeting.latestMessage.body}` : "No messages yet"}</span><span className="conversation-context"><span className="conversation-project">{meeting.participants.length} participants</span><span className="conversation-status">Active</span></span></span>
        <span className="conversation-meta">{meeting.latestMessage && <time>{relativeTime(meeting.latestMessage.createdAt)}</time>}</span></button>)}</div>
      {!meetings.length && <div className="empty-state refined-empty"><span><MessagesSquare /></span><h2>No meetings yet</h2><p>Start a focused channel with the full team or a smaller group.</p><button className="primary" onClick={() => setCreating(true)}><CalendarPlus />Start a meeting</button></div>}
    </main>
    {creating && <CreateMeeting connected={connected} onClose={() => setCreating(false)} onCreated={meeting => { setCreating(false); setMeetings(current => [meeting, ...current]); open(meeting); }} onError={onError} />}
    {selected && <MeetingChat id={selected} connected={connected} onClose={close} onError={onError} />}
  </>;
}

function CreateMeeting({ connected, onClose, onCreated, onError }: { connected: boolean; onClose: () => void; onCreated: (meeting: MeetingSummary) => void; onError: (message: string) => void }) {
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]); const [selected, setSelected] = useState<string[]>([]); const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void api.teamParticipants().then(result => { setParticipants(result.participants); setSelected(result.participants.map(keyOf)); }).catch(error => onError(error.message)); }, []);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!title.trim() || !selected.length || busy) return; setBusy(true); try { onCreated((await api.createMeeting(title.trim(), selected)).meeting); } catch (error) { onError(error instanceof Error ? error.message : "Could not create meeting"); setBusy(false); } };
  return <div className="modal-backdrop"><form className="form-modal meeting-create" onSubmit={submit}><div className="modal-heading"><div><span className="workspace-eyebrow">New channel</span><h2>Start a meeting</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
    <label>Meeting name<input autoFocus maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="Release readiness" /></label>
    <fieldset><legend>Participants</legend><p>Everyone is selected by default.</p>{participants.map(participant => <label className="participant-option" key={keyOf(participant)}><input type="checkbox" checked={selected.includes(keyOf(participant))} onChange={() => setSelected(current => current.includes(keyOf(participant)) ? current.filter(item => item !== keyOf(participant)) : [...current, keyOf(participant)])} /><ParticipantAvatar participant={participant} /><span><strong>{participant.name}</strong><small>{participant.title}</small></span></label>)}</fieldset>
    <div className="button-row"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!connected || busy || !title.trim() || !selected.length}>{busy ? "Starting…" : "Start meeting"}</button></div>
  </form></div>;
}

function MeetingChat({ id, connected, onClose, onError }: { id: string; connected: boolean; onClose: () => void; onError: (message: string) => void }) {
  const [meeting, setMeeting] = useState<MeetingSummary | null>(null); const [messages, setMessages] = useState<MeetingMessage[]>([]); const [message, setMessage] = useState(() => localStorage.getItem(`qahwa-meeting-draft:${id}`) ?? ""); const [sending, setSending] = useState(false); const stream = useRef<HTMLDivElement>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  useEffect(() => { localStorage.setItem(`qahwa-meeting-draft:${id}`, message); }, [id, message]);
  useEffect(() => { if (!connected) return; let stopped = false; let timer = 0; const poll = async () => { try { const result = await api.meeting(id); if (!stopped) { setMeeting(result.meeting); setMessages(result.messages); } } catch (error) { if (!stopped && !meeting) onError(error instanceof Error ? error.message : "Could not load meeting"); } if (!stopped) timer = window.setTimeout(() => void poll(), 1600); }; void poll(); return () => { stopped = true; window.clearTimeout(timer); }; }, [connected, id]);
  useEffect(() => { if (stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [messages.length]);
  const submit = async (event: FormEvent) => { event.preventDefault(); const text = message.trim(); if (!text || sending || !connected) return; setSending(true); try { const result = await api.sendMeetingMessage(id, text); setMeeting(result.meeting); setMessages(result.messages); setMessage(""); localStorage.removeItem(`qahwa-meeting-draft:${id}`); } catch (error) { onError(error instanceof Error ? error.message : "Could not send meeting message"); } finally { setSending(false); } };
  const mention = (participant: MeetingParticipant) => setMessage(current => `${current}${current && !/\s$/.test(current) ? " " : ""}@${participant.name} `);
  return <section className="chat-session orchestrator-page meeting-page"><header className="session-header"><button className="icon-button" onClick={onClose} aria-label="Back to meetings"><ArrowLeft /></button><span className="session-avatar meeting-avatar"><MessagesSquare /></span><div className="session-title"><span>Meeting</span><strong>{meeting?.title ?? "Loading…"}</strong><small>{meeting?.participants.map(item => item.name).join(", ")}</small></div>{meeting?.status === "active" && <button className="icon-button" onClick={() => setConfirmArchive(true)} aria-label="Archive meeting" title="Archive meeting"><Archive /></button>}</header>
    <div className="chat-workspace"><div className="chat-stream" ref={stream}><div className="chat-history">{messages.map(item => <MeetingEntry key={item.id} message={item} participant={meeting?.participants.find(participant => participant.type === item.speakerType && participant.id === item.speakerId)} />)}{!messages.length && <div className="session-empty"><span className="empty-orb"><MessagesSquare /></span><span className="empty-kicker">Ad hoc discussion</span><h2>Open the conversation</h2><p>Everyone answers an open message. Mention one or more people by name to narrow the reply.</p></div>}<div /></div></div>
      <div className="mention-strip" aria-label="Mention participants">{meeting?.participants.map(participant => <button type="button" key={keyOf(participant)} onClick={() => mention(participant)}>@{participant.name}</button>)}</div>
      <form className="chat-composer" onSubmit={submit}><div className="composer-field"><textarea className="composer-message" rows={1} value={message} onChange={event => setMessage(event.target.value)} placeholder="Message the meeting" /><button className="send-button" type="submit" disabled={!connected || sending || !message.trim()} aria-label="Send"><Send /></button></div></form>
    </div>{confirmArchive && <ActionDialog title="Archive this meeting?" description="Its participant list and complete transcript will be preserved." confirmLabel="Archive meeting" pendingLabel="Archiving…" onClose={() => setConfirmArchive(false)} onConfirm={async () => { await api.archiveMeeting(id); setConfirmArchive(false); onClose(); }} />}</section>;
}

function MeetingEntry({ message, participant }: { message: MeetingMessage; participant?: MeetingParticipant }) {
  const entry = { id: message.id, ownerType: "orchestrator" as const, ownerId: message.meetingId, role: message.speakerType === "user" ? "user" as const : "assistant" as const, body: message.body, itemId: null, metadata: null, createdAt: message.createdAt };
  return <article className={`chat-message ${entry.role}`}><span className="message-avatar">{message.speakerType === "user" ? <UserAvatar /> : participant ? <ParticipantAvatar participant={participant} /> : <MessagesSquare />}</span><div className="message-content"><div className="message-role"><div className="message-metadata"><span className="message-sender">{message.speakerName}</span><span className="speaker-title">{message.speakerTitle}</span><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{message.status && <span className={`dispatch-state ${message.status}`}>{message.status}</span>}</div></div><MessageBody entry={entry} /></div></article>;
}

function ParticipantAvatar({ participant }: { participant: MeetingParticipant }) { return participant.type === "orchestrator" ? <span className="team-avatar"><OrchestratorAvatar /></span> : <TeamAvatar member={{ id: participant.id, name: participant.name, avatar: participant.avatar }} />; }
const keyOf = (participant: MeetingParticipant) => `${participant.type}:${participant.id}`;
function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000)); return minutes < 1 ? "Now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
function meetingFromPath() { const match = /^\/meetings\/([^/]+)$/.exec(location.pathname); return match ? decodeURIComponent(match[1]!) : null; }
