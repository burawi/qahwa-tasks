import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppDatabase } from "../server/database.js";
import type { TaskService } from "../server/task-service.js";
import { MessageSchedules } from "../server/message-schedules.js";
import { assertDomain } from "../domain/errors.js";
import { scheduleZoneLabel } from "../domain/schedule-time.js";

export function registerFollowupTools(server: McpServer, database: AppDatabase, tasks: TaskService): void {
  const schedules = new MessageSchedules(database, tasks);
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const taskId = z.string().min(1).max(100), messageId = z.string().min(1).max(100);
  const policy = z.enum(["when_available", "skip_if_missed"]);
  const result = (schedule: NonNullable<ReturnType<MessageSchedules["get"]>>) => ({
    ...schedule, timezoneLabel: scheduleZoneLabel(schedule.runAt, schedule.timezone),
    message: (database.db.prepare("SELECT body FROM chat_messages WHERE id=?").get(schedule.messageId) as {body:string}).body,
  });
  server.registerTool("list_followups", {
    description: "Read scheduled follow-ups in an existing task conversation before changing or cancelling one. Includes pending, reserved and interrupted deliveries by default; use includeHistory for past delivery states.",
    inputSchema: { taskId, includeHistory: z.boolean().default(false) }, annotations: { readOnlyHint: true },
  }, ({ taskId, includeHistory }) => text(schedules.list(taskId).filter(s => includeHistory || ["pending", "reserved", "interrupted"].includes(s.state)).map(result)));
  server.registerTool("schedule_followup", {
    description: "Save a user's conversational request to do work later in this same task session, such as 'do this today at 9pm'. Do not perform the work now. Resolve the action from conversation context and pass the original user sourceMessageId from the submission context, an absolute localTime (YYYY-MM-DDTHH:mm), and an explicit timezone only when the user overrides the captured device timezone. Ask if timing is ambiguous. Defaults to Run when available. Retries for one source request return the existing schedule without changing it or reviving cancellation. Confirm the returned time, timezone and state only after success. Scheduling grants no extra permissions.",
    inputSchema: { taskId, sourceMessageId: messageId, message: z.string().trim().min(1).max(30_000),
      localTime: z.string(), timezone: z.string().max(100).optional(), policy: policy.default("when_available") },
    annotations: { idempotentHint: true, destructiveHint: false },
  }, ({ taskId, sourceMessageId, ...input }) => text(result(schedules.fromChat(taskId, sourceMessageId, input))));
  server.registerTool("edit_followup", {
    description: "Apply a user's conversational change to a pending scheduled follow-up using the version from list_followups. Omitted text/time/zone/policy stay unchanged. Once delivery is reserved the edit is rejected; never retry with a guessed version.",
    inputSchema: { taskId, messageId, expectedVersion: z.number().int().positive(), message: z.string().trim().min(1).max(30_000).optional(),
      localTime: z.string().optional(), timezone: z.string().max(100).optional(), policy: policy.optional() },
    annotations: { destructiveHint: false },
  }, ({ taskId, messageId, ...input }) => {
    const task = tasks.getTask(taskId), current = schedules.get(messageId);
    assertDomain(current && current.taskId === task.id, "This message is not in this chat", "message_not_found", 404);
    const body = (database.db.prepare("SELECT body FROM chat_messages WHERE id=?").get(messageId) as {body:string}).body;
    return text(result(schedules.save(task.id, messageId, { expectedVersion: input.expectedVersion,
      localTime: input.localTime ?? current.localTime, timezone: input.timezone ?? current.timezone,
      policy: input.policy ?? current.policy, message: input.message ?? body })));
  });
  server.registerTool("cancel_followup", {
    description: "Remove a pending follow-up when the user asks to cancel it. Requires the version from list_followups, retains chat history and leaves the task open. Delivery already reserved cannot be cancelled.",
    inputSchema: { taskId, messageId, expectedVersion: z.number().int().positive() }, annotations: { destructiveHint: false },
  }, ({ taskId, messageId, expectedVersion }) => {
    schedules.cancel(taskId, messageId, expectedVersion);
    return text(result(schedules.get(messageId)!));
  });
}
