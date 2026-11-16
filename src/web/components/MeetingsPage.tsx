import { Archive, ArrowLeft, CalendarPlus, File, MessagesSquare, Mic, Plus, RotateCw, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatAttachment, MeetingMessage, MeetingParticipant, MeetingSummary } from "../../domain/types";
import { api } from "../api";
import { useVoiceMessage } from "../use-voice-message";
import "../voice-message.css";
import { ActionDialog } from "./ActionDialog";
import { AttachmentMenu } from "./AttachmentMenu";
import { MessageBody } from "./MessageBody";
import { OrchestratorAvatar } from "./OrchestratorAvatar";
import { TeamAvatar } from "./TeamAvatar";
import { UserAvatar } from "./UserAvatar";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES = 250 * 1024 * 1024;

interface ComposerAttachment {
  localId: string;
  file: File;
  preview: string | null;
  attachment: ChatAttachment | null;
  progress: number;
  error: string | null;
}

export function MeetingsPage({ connected, onError }: { connected: boolean; onError: (message: string) => void }) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => meetingFromPath());
  const [creating, setCreating] = useState(false);
  const load = async () => setMeetings((await api.meetings()).meetings);
  useEffect(() => {
    const syncFromPath = () => setSelected(meetingFromPath());
    window.addEventListener("popstate", syncFromPath);
    return () => window.removeEventListener("popstate", syncFromPath);
  }, []);
  useEffect(() => {
    if (!connected) return;
    let stopped = false; let timer = 0;
    const poll = async () => {
      try { const next = (await api.meetings()).meetings; if (!stopped) setMeetings(next); }
      catch (error) { if (!stopped && !meetings.length) onError(error instanceof Error ? error.message : "Could not load meetings"); }
      if (!stopped) timer = window.setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [connected]);
  const open = (meeting: MeetingSummary) => { history.pushState({}, "", `/meetings/${meeting.id}`); setSelected(meeting.id); };
  const close = () => { history.pushState({}, "", "/meetings"); setSelected(null); void load().catch(() => undefined); };
  return <>
    <main className="unified-task-list meetings-list-page"><div className="workspace-intro"><span className="workspace-eyebrow">Think together</span><h1>Meetings</h1><p>Durable, ad hoc discussions with the orchestrator and your selected team.</p></div>
      <div className="section-heading"><div><h2>Active meetings</h2><p>Open messages go to everyone; @mentions address specific participants.</p></div><button className="primary" onClick={() => setCreating(true)}><Plus />New meeting</button></div>
      <div className="task-rows meeting-rows">{meetings.map(meeting => <button className="task-row conversation-row" key={meeting.id} onClick={() => open(meeting)}>
        <span className="meeting-list-avatar"><MessagesSquare /></span><span className="conversation-copy"><strong className="conversation-title">{meeting.title}</strong><span className="conversation-preview">{meeting.latestMessage ? meetingPreview(meeting.latestMessage) : "No messages yet"}</span><span className="conversation-context"><span className="conversation-project">{meeting.participants.length} participants</span><span className="conversation-status">Active</span></span></span>
        <span className="conversation-meta">{meeting.latestMessage && <time>{relativeTime(meeting.latestMessage.createdAt)}</time>}</span></button>)}</div>
      {!meetings.length && <div className="empty-state refined-empty"><span><MessagesSquare /></span><h2>No meetings yet</h2><p>Start a focused channel with the full team or a smaller group.</p><button className="primary" onClick={() => setCreating(true)}><CalendarPlus />Start a meeting</button></div>}
    </main>
    {creating && <CreateMeeting connected={connected} onClose={() => setCreating(false)} onCreated={meeting => { setCreating(false); setMeetings(current => [meeting, ...current]); open(meeting); }} onError={onError} />}
    {selected && <MeetingChat key={selected} id={selected} connected={connected} onClose={close} onError={onError} />}
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
  const [meeting, setMeeting] = useState<MeetingSummary | null>(null);
  const [messages, setMessages] = useState<MeetingMessage[]>([]);
  const [message, setMessage] = useState(() => localStorage.getItem(`qahwa-meeting-draft:${id}`) ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const stream = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const attemptRef = useRef<{ id: string; text: string; attachmentIds: string[] } | null>(null);
  const loadErrorRef = useRef<string | null>(null);
  const voice = useVoiceMessage("meeting", id);

  useEffect(() => { if (message) localStorage.setItem(`qahwa-meeting-draft:${id}`, message); else localStorage.removeItem(`qahwa-meeting-draft:${id}`); }, [id, message]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => { for (const item of attachmentsRef.current) if (item.preview) URL.revokeObjectURL(item.preview); }, []);
  useEffect(() => {
    if (!connected) return;
    let stopped = false; let timer = 0;
    const poll = async () => {
      try { const result = await api.meeting(id); if (!stopped) { loadErrorRef.current = null; setMeeting(result.meeting); setMessages(result.messages); } }
      catch (error) {
        const detail = error instanceof Error ? error.message : "Could not load meeting";
        if (!stopped && loadErrorRef.current !== detail) { loadErrorRef.current = detail; onError(detail); }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 1600);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [connected, id]);
  useEffect(() => { if (stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [messages.length]);
  useEffect(() => {
    if (meeting?.status === "archived" || (!connected && voice.phase === "requesting")) voice.cancel();
    else if (!connected && voice.phase === "recording") voice.stop();
  }, [connected, meeting?.status, voice.phase, voice.cancel]);

  const upload = (item: ComposerAttachment) => {
    void api.uploadAttachment("meeting", id, item.file, progress => {
      setAttachments(current => current.map(entry => entry.localId === item.localId ? { ...entry, progress } : entry));
    }).then(attachment => {
      setAttachments(current => current.map(entry => entry.localId === item.localId ? { ...entry, attachment, progress: 100, error: null } : entry));
    }).catch(error => {
      const detail = error instanceof Error ? error.message : "Upload failed";
      setAttachments(current => current.map(entry => entry.localId === item.localId ? { ...entry, error: detail } : entry));
      onError(detail);
    });
  };
  const addFiles = (files: File[]) => {
    if (!connected || sending || meeting?.status === "archived" || !files.length) return;
    const combined = [...attachments.map(item => item.file), ...files];
    if (files.some(file => file.size > MAX_ATTACHMENT_BYTES)) { onError("Each file may be at most 100 MiB"); return; }
    if (combined.reduce((sum, file) => sum + file.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) { onError("Files may total at most 250 MiB per message"); return; }
    const additions = files.map((file): ComposerAttachment => ({ localId: crypto.randomUUID(), file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null, attachment: null, progress: 0, error: null }));
    setAttachments(current => [...current, ...additions]);
    additions.forEach(upload);
  };
  const removeAttachment = (item: ComposerAttachment) => {
    if (!item.attachment && !item.error) return;
    setAttachments(current => current.filter(entry => entry.localId !== item.localId));
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.attachment) void api.removeAttachment(item.attachment.id).catch(error => onError(error instanceof Error ? error.message : "Could not remove file"));
  };
  const retryAttachment = (item: ComposerAttachment) => {
    const retry = { ...item, attachment: null, progress: 0, error: null };
    setAttachments(current => current.map(entry => entry.localId === item.localId ? retry : entry));
    upload(retry);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (sendingRef.current || !connected || voice.blocked || meeting?.status === "archived") return;
    const text = [message.trim(), voice.phase === "review" ? voice.transcript.trim() : ""].filter(Boolean).join("\n\n");
    const ready = attachments.map(item => item.attachment).filter((item): item is ChatAttachment => Boolean(item));
    if ((!text && !ready.length) || attachments.some(item => !item.attachment || item.error)) return;
    const attachmentIds = ready.map(item => item.id);
    const previous = attemptRef.current;
    const attempt = previous && previous.text === text && JSON.stringify(previous.attachmentIds) === JSON.stringify(attachmentIds)
      ? previous : { id: crypto.randomUUID(), text, attachmentIds };
    attemptRef.current = attempt; sendingRef.current = true; setSending(true);
    void api.sendMeetingMessage(id, text, attachmentIds, attempt.id).then(result => {
      setMeeting(result.meeting); setMessages(result.messages); setMessage(""); voice.cancel(); attemptRef.current = null;
      setAttachments([]); for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
    }).catch(error => onError(error instanceof Error ? error.message : "Could not send meeting message"))
      .finally(() => { sendingRef.current = false; setSending(false); });
  };
  const mention = (participant: MeetingParticipant) => setMessage(current => `${current}${current && !/\s$/.test(current) ? " " : ""}@${participant.name} `);
  const archived = meeting?.status === "archived";

  return <section className="chat-session orchestrator-page meeting-page"><header className="session-header"><button className="icon-button" onClick={onClose} aria-label="Back to meetings"><ArrowLeft /></button><span className="session-avatar meeting-avatar"><MessagesSquare /></span><div className="session-title"><span>Meeting</span><strong>{meeting?.title ?? "Loading…"}</strong><small>{meeting?.participants.map(item => item.name).join(", ")}</small></div>{meeting?.status === "active" && <button className="icon-button" onClick={() => setConfirmArchive(true)} aria-label="Archive meeting" title="Archive meeting"><Archive /></button>}</header>
    <div className="chat-workspace"><div className="chat-stream" ref={stream}><div className="chat-history">{messages.map(item => <MeetingEntry key={item.id} message={item} participant={meeting?.participants.find(participant => participant.type === item.speakerType && participant.id === item.speakerId)} />)}{!messages.length && <div className="session-empty"><span className="empty-orb"><MessagesSquare /></span><span className="empty-kicker">Ad hoc discussion</span><h2>Open the conversation</h2><p>Everyone answers an open message. Mention one or more people by name to narrow the reply.</p></div>}<div /></div></div>
      <div className="mention-strip" aria-label="Mention participants">{meeting?.participants.map(participant => <button type="button" key={keyOf(participant)} disabled={archived} onClick={() => mention(participant)}>@{participant.name}</button>)}</div>
      {archived ? <div className="closed-composer">Meeting archived</div> : <form className={`chat-composer${dragging ? " dragging" : ""}`} onSubmit={submit}
        onDragEnter={event => { event.preventDefault(); if (connected && !sending) setDragging(true); }} onDragOver={event => event.preventDefault()}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
        <div className={`composer-field${attachments.length || voice.phase !== "idle" ? " expanded" : ""}`}>
          {(attachments.length > 0 || voice.phase !== "idle") && <div className="composer-context">
            {voice.phase !== "idle" && <div className="voice-panel" aria-label="Voice message"><div className="voice-heading"><span role="status">{voice.phase === "recording" ? `Recording ${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, "0")} / 5:00` : voice.phase === "requesting" ? "Preparing microphone…" : voice.phase === "processing" ? "Transcribing…" : voice.phase === "review" ? "Review your transcript before Send" : "Voice message needs attention"}</span><button type="button" disabled={sending} onClick={voice.cancel} aria-label="Cancel voice message"><X /></button></div>
              {voice.phase === "recording" && <button className="voice-stop" type="button" onClick={voice.stop}><Square aria-hidden="true" /> Stop recording</button>}
              {voice.preview && <audio controls preload="metadata" src={voice.preview} aria-label="Recording preview" />}
              {voice.error && <p role="alert">{voice.error}</p>}
              {voice.phase === "error" && <button type="button" disabled={!connected} onClick={voice.retry}>Retry voice message</button>}
              {voice.phase === "review" && <><textarea aria-label="Voice transcript" value={voice.transcript} onChange={event => voice.setTranscript(event.target.value)} readOnly={sending} rows={3} /><small>Only text will be sent, together with your typed draft and selected files.</small></>}
            </div>}
            {attachments.length > 0 && <div className="composer-attachments" role="region" aria-label="Files to send" tabIndex={0}>{attachments.map(item => <div className={`attachment-chip${item.preview ? " image" : ""}${item.error ? " error" : ""}`} key={item.localId}>{item.preview ? <img src={item.preview} alt={`Preview of ${item.file.name}`} /> : <File aria-hidden="true" />}<span><strong title={item.file.name}>{item.file.name}</strong><small role={item.error ? "alert" : "status"}>{item.error ?? (item.attachment ? formatFileSize(item.file.size) : `Uploading ${item.progress}%`)}</small></span>{item.error && <button className="attachment-retry" type="button" onClick={() => retryAttachment(item)} aria-label={`Retry ${item.file.name}`}><RotateCw /></button>}<button type="button" disabled={!item.attachment && !item.error} onClick={() => removeAttachment(item)} aria-label={`Remove ${item.file.name}`}><X /></button>{!item.attachment && !item.error && <progress value={item.progress} max={100} aria-label={`Uploading ${item.file.name}`} />}</div>)}</div>}
          </div>}
          <textarea aria-label="Message" inputMode="text" className="composer-message" rows={1} value={message} onChange={event => setMessage(event.target.value)} placeholder="Message the meeting" />
          <AttachmentMenu disabled={!connected || sending} onFiles={addFiles} />
          <button className="voice-record-button" type="button" disabled={sending || !connected || !voice.supported || voice.phase !== "idle"} onClick={() => void voice.start()} aria-label="Record voice message" title="Record a voice message (five minutes maximum)"><Mic /></button>
          <button className="send-button" type="submit" disabled={!connected || sending || voice.blocked || attachments.some(item => !item.attachment || Boolean(item.error)) || (!message.trim() && !attachments.some(item => item.attachment) && !(voice.phase === "review" && voice.transcript.trim()))} aria-label="Send"><Send /></button>
        </div>
        {!voice.supported && <span className="voice-unsupported" role="status">Voice recording needs a supported browser with HTTPS and microphone access.</span>}
      </form>}
    </div>{confirmArchive && <ActionDialog title="Archive this meeting?" description="Its participant list and complete transcript will be preserved." confirmLabel="Archive meeting" pendingLabel="Archiving…" onClose={() => setConfirmArchive(false)} onConfirm={async () => { await api.archiveMeeting(id); setConfirmArchive(false); onClose(); }} />}</section>;
}

function MeetingEntry({ message, participant }: { message: MeetingMessage; participant?: MeetingParticipant }) {
  const entry = { id: message.id, ownerType: "orchestrator" as const, ownerId: message.meetingId,
    role: message.speakerType === "user" ? "user" as const : "assistant" as const, body: message.body, itemId: null,
    metadata: message.attachments.length ? { attachments: message.attachments } : null, createdAt: message.createdAt };
  return <article className={`chat-message ${entry.role}`}><span className="message-avatar">{message.speakerType === "user" ? <UserAvatar /> : participant ? <ParticipantAvatar participant={participant} /> : <MessagesSquare />}</span><div className="message-content"><div className="message-role"><div className="message-metadata"><span className="message-sender">{message.speakerName}</span><span className="speaker-title">{message.speakerTitle}</span><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{message.status && <span className={`dispatch-state ${message.status}`}>{message.status}</span>}</div></div><MessageBody entry={entry} /></div></article>;
}

function ParticipantAvatar({ participant }: { participant: MeetingParticipant }) { return participant.type === "orchestrator" ? <span className="team-avatar"><OrchestratorAvatar /></span> : <TeamAvatar member={{ id: participant.id, name: participant.name, avatar: participant.avatar }} />; }
const keyOf = (participant: MeetingParticipant) => `${participant.type}:${participant.id}`;
function meetingPreview(message: MeetingMessage) { return `${message.speakerName}: ${message.body || (message.attachments.length === 1 ? `Attached ${message.attachments[0]!.filename}` : `Attached ${message.attachments.length} files`)}`; }
function formatFileSize(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`; }
function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000)); return minutes < 1 ? "Now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
function meetingFromPath() { const match = /^\/meetings\/([^/]+)$/.exec(location.pathname); return match ? decodeURIComponent(match[1]!) : null; }
