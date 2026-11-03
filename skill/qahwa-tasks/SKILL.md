---
name: qahwa-tasks
description: Manage records in the user's private Qahwa Tasks system. Use when the user asks to list, create, edit, prioritize, review, comment on, or explicitly close Qahwa tasks; do not use for unrelated generic task lists.
---

# Qahwa Tasks workflow

Use the `qahwa-tasks` MCP tools as the authoritative record interface. Do not write its SQLite database directly.

Every triggered task has a persistent built-in Codex session. The built-in orchestrator is a full Codex session with additional portfolio context, prioritization, and capacity-aware coordination. It can create and manage tasks through MCP and carry out other work the user requests directly. Its coordination action envelope supplements its normal tools; it does not define the limits of its capabilities.

## Read narrowly

1. Follow the user's stated scope and project filter.
2. Use `list_tasks` for the requested view or project.
3. Load only the task records needed for the request. Omit resolved history unless current context is insufficient.
4. Use `rootDirectory` to locate the relevant project. A request to manage records does not by itself request implementation; when the user requests implementation directly, follow that scope and coordinate with any active task session sharing the worktree.

## Create and edit tasks

- A new task is a short, plain note attached to one project. Create it in Backlog unless the user explicitly requests Todo.
- Do not invent requirements or commitments. The task session can clarify the note after the user or orchestrator triggers it.
- Before updating a task, reload its current version and preserve newer user changes.
- Use repository evidence only when the user explicitly asks to elaborate a task. Repository inspection for elaboration is read-only.

## Execution and priority

- Creating a task never starts it.
- Task execution is triggered only by the user or by the built-in orchestrator after user authorization.
- The built-in orchestrator decides safe parallelism from current computer capacity and can apply a user-authorized priority order.
- Task chats provide focused context for clarification, progress, design collaboration, and implementation follow-up. The orchestrator can also help directly and relay user-authorized instructions to task sessions; the user does not need to move between chats to obtain normal Codex capabilities.
- Preserve authorization already given in the conversation and respect subsequent changes. Distinguish direct user requests from automated portfolio observations, which rely on the active standing directive for new work.

## Conversational follow-ups

- In an existing Qahwa conversation, understand requests such as "do this today at 9pm" from the normal message. Resolve the action from context, then use `schedule_followup` with that user message's `sourceMessageId` and an absolute local time. Do the work when the follow-up is delivered, not while saving it.
- Use the submission date and captured device timezone for relative times; an explicit user timezone takes precedence. Ask only for genuinely missing or ambiguous information. Clear requests default to Run when available and need no extra confirmation.
- Confirm the exact saved date, time and timezone only after the tool succeeds. Use `list_followups`, `edit_followup` and `cancel_followup` for subsequent requests, preserving saved versions. A retry must never create a duplicate or revive cancellation.
- Examples, quoted text and deadlines do not by themselves authorize scheduling. Saving delivery metadata grants no implementation, deployment, publishing, commit or task closure permission. A due scheduled delivery must not be scheduled again automatically.

## Lifecycle

- The normal lifecycle is `backlog -> todo -> in_progress -> in_review -> closed`.
- A task session may move a task to review only when implementation and proportionate validation are actually complete.
- Review feedback returns the task to work through its task session.
- Never close or cancel a task by assumption. Closure requires the user's explicit instruction for that task.

## Record-only operations

It is acceptable to list, create, edit, relate, prioritize, comment on, or explicitly close records through MCP when the user asks. Do not claim that a record-only operation triggered or completed implementation.

## Context hygiene

- Prefer concise current state, unresolved comments, and the latest output.
- Do not paste full chat transcripts into task records.
- Do not retain unrelated task details after the requested record operation is complete.
