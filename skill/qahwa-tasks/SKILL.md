---
name: qahwa-tasks
description: Manage records and implementation work in the user's private Qahwa Tasks system, including its Backlog, Todo, Open, review, comments, and project-root workflow. Use when the user names Qahwa Tasks or asks to create, perform, review, or close tasks stored in that system; do not use for unrelated generic task lists.
---

# Qahwa Tasks workflow

Use the `qahwa-tasks` MCP tools as the authoritative task interface. Do not write the SQLite database directly.

## Read narrowly

1. Follow the user's stated scope; do not force a fixed task-selection rule.
2. Use `list_tasks` for the requested tab or project.
3. Load one task at a time with `get_task`. By default, keep resolved history omitted.
4. Use the project's returned `rootDirectory` as the working directory and obey that repository's `AGENTS.md`.
5. Load resolved comment history only when current context and the latest handoff are insufficient.

## Create tasks

- Create discussed notes as Backlog tasks unless the user explicitly asks for Todo.
- Use a clear title and the optional Goal, Details, and Done when sections.
- Do not invent commitments that were not agreed during the discussion.
- New tasks belong at the bottom; the user controls priority through ordering.

## Perform tasks

1. A task must pass through `backlog -> todo -> in_progress`; never start directly from Backlog.
2. Call `start_task` immediately before substantive work. This notifies the user.
3. Check unresolved comments and current task version before editing or implementing.
4. Use `add_comment` with `requiresResponse: true` only when blocked on the user's answer or approval.
5. Resolve a comment thread when its concern is actually addressed; add a concise reply when useful.
6. Before review, re-read the current task and check for comments added during work.
7. Call `submit_for_review` with a compact handoff: session ID when available, summary, validation, commit hash when applicable, and limitations. This notifies the user.
8. After review submission, stop loading that task while working on later tasks unless the user returns to it.

## Review and closure

- Review feedback moves a task from `in_review` to `in_progress` using `return_to_work`.
- Never close or cancel a task by assumption, because implementation appears complete, or because the user is silent.
- Call `close_task` only when the user explicitly instructs closure of that specific task. Pass the explicit instruction through the tool.
- Completed tasks must come from `in_review`. Cancellation is available from Todo or later.

## Context hygiene

- Treat Qahwa Tasks as durable working memory.
- Prefer concise MCP results, current unresolved comments, and the latest handoff.
- Do not paste full transcripts into tasks or handoffs.
- Do not keep previously reviewed task details active while processing a batch; move task-by-task in global priority order unless the user gives another order.
