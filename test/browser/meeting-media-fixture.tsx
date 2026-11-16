import React from "react";
import { createRoot } from "react-dom/client";
import { MeetingsPage } from "meeting-source";
import { api } from "meeting-api";
import "meeting-styles";

const stamp = new Date().toISOString();
const controls = window.meetingFixture = {
  failSend: false, available: true, failTranscription: false, sent: [], removed: [], uploads: [], error: "", errors: [], serial: 0,
  meetingCalls: [], failMeetingIds: [],
  meeting: { id: "meeting-1", title: "Release readiness", status: "active", participants: [], latestMessage: null, createdAt: stamp, updatedAt: stamp },
  otherMeeting: { id: "meeting-2", title: "Product direction", status: "active", participants: [], latestMessage: null, createdAt: stamp, updatedAt: stamp },
  messages: [{ id: "history-1", meetingId: "meeting-1", speakerType: "user", speakerId: null, speakerName: "You", speakerTitle: "",
    body: "Earlier evidence", attachments: [{ id: "expired-1", filename: "old-plan.txt", mediaType: "text/plain", size: 12,
      status: "expired", previewUrl: "/api/meetings/meeting-1/attachments/expired-1" }], createdAt: stamp }],
};
Object.assign(api, {
  meetings: async () => ({ meetings: [structuredClone(controls.meeting), structuredClone(controls.otherMeeting)] }),
  meeting: async id => {
    controls.meetingCalls.push(id);
    if (controls.failMeetingIds.includes(id)) throw new Error(`Could not load ${id}`);
    const meeting = id === controls.otherMeeting.id ? controls.otherMeeting : controls.meeting;
    return { meeting: structuredClone(meeting), messages: id === controls.meeting.id ? structuredClone(controls.messages) : [] };
  },
  archiveMeeting: async () => ({ meeting: { ...controls.meeting, status: "archived" } }),
  sendMeetingMessage: async (_id, text, attachmentIds, requestId) => {
    controls.sent.push({ text, attachmentIds: [...attachmentIds], requestId });
    await new Promise(resolve => setTimeout(resolve, 80));
    if (controls.failSend) throw new Error("Meeting send failed");
    const attachments = controls.uploads.filter(item => attachmentIds.includes(item.id));
    if (!controls.messages.some(item => item.clientRequestId === requestId)) controls.messages.push({
      id: `sent-${requestId}`, meetingId: "meeting-1", speakerType: "user", speakerId: null, speakerName: "You", speakerTitle: "",
      body: text, attachments, clientRequestId: requestId, createdAt: new Date().toISOString(), status: "pending",
    });
    return { meeting: structuredClone(controls.meeting), messages: structuredClone(controls.messages) };
  },
  uploadAttachment: async (_mode, _id, file, progress) => {
    progress(40); await new Promise(resolve => setTimeout(resolve, 40)); progress(100);
    const attachment = { id: `upload-${++controls.serial}`, filename: file.name, mediaType: file.type || "application/octet-stream",
      size: file.size, status: "available", previewUrl: `/api/meetings/meeting-1/attachments/upload-${controls.serial}` };
    controls.uploads.push(attachment); return attachment;
  },
  removeAttachment: async id => { controls.removed.push(id); },
  voiceAvailable: async () => ({ available: controls.available }),
  startVoiceTranscription: async () => ({ transcription: { id: "meeting-job", status: "processing" } }),
  voiceTranscription: async id => ({ transcription: controls.failTranscription ? { id, status: "failed", error: "Transcription failed. Please retry." }
    : { id, status: "complete", text: "Editable meeting transcript" } }),
  cancelVoiceTranscription: async () => {},
  userAvatar: async () => ({ avatar: null }),
  teamParticipants: async () => ({ participants: [] }),
});

createRoot(document.getElementById("root")).render(<MeetingsPage connected onError={message => { controls.error = message; controls.errors.push(message); }} />);
