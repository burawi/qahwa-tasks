import type { ChatMessage } from "../domain/types.js";

/** Give the conversation its own submission clock; interpretation stays with the agent. */
export function chatSchedulingInstructions(message: ChatMessage, delivered: boolean, now = new Date()): string {
  if (delivered) return "This is the due delivery of an already-saved scheduled follow-up. Carry out its action now under the existing permissions. Do not schedule it again because of an original timing phrase. No extra implementation, deployment, publishing, commit or closure permission is granted.";
  if (message.role !== "user") return "";
  const timezone = message.metadata?.submissionTimezone;
  let submittedLocalTime: string | null = null;
  if (typeof timezone === "string") {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(message.createdAt)).map(p => [p.type, p.value]));
    submittedLocalTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  return `Conversational follow-up scheduling: Understand the user's intent in the normal conversation. If they ask to do work later (for example "do this today at 9pm"), use the qahwa_tasks schedule_followup tool for this task and the sourceMessageId below. Resolve "this" from the conversation and save a self-contained action to run later; do not carry out the requested work now. Do not ask them to use a form or another conversation. Clear requests should be saved immediately, then confirmed briefly with the exact date, time and timezone returned by the tool. Never claim a schedule was saved before the tool succeeds. Default to Run when available unless the user requests Skip if missed. Use list_followups, edit_followup and cancel_followup for conversational changes, checking the saved version. Ask a concise question if the action, date, time or timezone is genuinely ambiguous; do not guess an unspecified morning/evening, silently roll a past time forward, or invent a timezone. Interpret relative dates using the submission clock below, even if this turn waited in the queue. An explicit timezone in the request overrides the device timezone. Examples, quotes, code, deadlines and discussion about scheduling are not themselves requests to schedule. Saving user-requested delivery metadata is permitted during read-only intake; it does not authorize project file edits or bypass intake permissions at delivery. Scheduling grants no additional permissions.\nSubmission context: ${JSON.stringify({ sourceMessageId: message.id, submittedAt: message.createdAt, deviceTimezone: timezone ?? null, submittedLocalTime, currentTime: now.toISOString() })}.`;
}
