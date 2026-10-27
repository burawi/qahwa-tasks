---
name: qahwa-tasks
description: Manage records in the user's private Qahwa Tasks system. Use when the user asks to list, create, edit, prioritize, review, comment on, or explicitly close Qahwa tasks; do not use for unrelated generic task lists.
---

# Qahwa Tasks workflow

Use the `qahwa-tasks` MCP tools as the authoritative record interface. Do not write its SQLite database directly.

Qahwa Tasks owns execution itself. Every triggered task has one persistent built-in Codex session, and the single built-in orchestrator coordinates prioritization and capacity-aware starts. Do not launch a separate external worker for a Qahwa task or substitute another application’s session model.

## Read narrowly

1. Follow the user's stated scope and project filter.
2. Use `list_tasks` for the requested view or project.
3. Load only the task records needed for the request. Omit resolved history unless current context is insufficient.
4. Treat the returned `rootDirectory` as project metadata, not authority to begin implementation outside the task's built-in session.

## Create and edit tasks

- A new task is a short, plain note attached to one project. Create it in Backlog unless the user explicitly requests Todo.
- Do not invent requirements or commitments. The task session can clarify the note after the user or orchestrator triggers it.
- Before updating a task, reload its current version and preserve newer user changes.
- Use repository evidence only when the user explicitly asks to elaborate a task. Repository inspection for elaboration is read-only.

## Execution and priority

- Creating a task never starts it.
- Task execution is triggered only by the user or by the built-in orchestrator after user authorization.
- The built-in orchestrator decides safe parallelism from current computer capacity and can apply a user-authorized priority order.
- Use the app's task chat for clarification, approvals, progress, design-canvas collaboration, and implementation follow-up.
- Use the app's orchestrator chat for portfolio priorities, dependencies, capacity decisions, and material cross-task updates.

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
