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

### Elaborate tasks from repository evidence

Before substantially expanding an existing note or rewriting it into a detailed task:

1. Load the current task with `get_task` and use its returned project `rootDirectory`. Keep the task version and unresolved comments current before calling `update_task`.
2. Read every applicable `AGENTS.md` from the project root through the relevant implementation directories.
3. Research the repository read-only with focused searches for the named feature. Inspect the relevant implementation surfaces and, when they affect the task, the current data model or contracts, UI flow, tests, and deployment or integration boundaries.
4. Stop researching once there is enough evidence to describe an accurate scope. Do not edit code, run mutating commands, change configuration or data, or turn elaboration into implementation.
5. Preserve the user's stated intent and scope. Ground confirmed details in the components and constraints actually found, keep unresolved product or technical decisions visibly unresolved, and do not invent requirements, solutions, or commitments.
6. Update only the task record with `update_task` and its current version. If the version changed, reload the task and reconcile the user's newer edits before retrying.

## Perform tasks

### Keep the main session as the orchestrator

For any request to implement, perform, or revise Qahwa tasks, the main session must remain an orchestration layer and must not do task-specific repository work itself.

- The main session may list the requested queue, select the next task, dispatch workers, receive compact results, and verify final task statuses.
- Delegate each task to a new subagent with `fork_turns="none"`. Do not reuse a worker for another task and do not pass accumulated parent conversation history.
- Give the worker only the task ID, the user's current scope/order, and an instruction to read and follow this skill. The worker must load the task details and project root itself.
- Run one task worker at a time in global priority order unless the user explicitly chooses another order. Wait until that worker has submitted or reported a blocker before dispatching the next task.
- The worker owns the complete task lifecycle: `get_task`, `start_task`, unresolved-comment handling, repository work, validation, final task re-read, and `submit_for_review`.
- Require a compact worker result containing only task ID, resulting status, summary, validation, and limitations. Do not return implementation logs, full task content, or repository exploration to the main session.
- Apply the same fresh-worker rule when review feedback requires implementation changes.
- Record-only actions such as listing, creating, prioritizing, commenting on, or explicitly closing tasks may be performed directly by the main session when no repository implementation is involved.
- If fresh subagents are unavailable, stop and explain that the required isolated-worker workflow cannot be followed; do not fall back to implementing tasks in the main session.

1. A task must pass through `backlog -> todo -> in_progress`; never start directly from Backlog.
2. Call `start_task` immediately before substantive work. This notifies the user.
3. Check unresolved comments and current task version before editing or implementing.
4. Use `add_comment` with `requiresResponse: true` only when blocked on the user's answer or approval.
5. Resolve a comment thread when its concern is actually addressed; add a concise reply when useful.
6. Before review, re-read the current task and check for comments added during work.
7. Call `submit_for_review` with a compact handoff: session ID when available, summary, validation, commit hash when applicable, and limitations. This notifies the user.
8. After review submission, stop loading that task while working on later tasks unless the user returns to it.

### Commit approval proposals

For completed coding work that is suitable for a scoped commit, include `commitProposal` in `submit_for_review`. Record the proposed message, exact Git repository root, full current HEAD revision, every reviewed repository-relative file, and a concise release note. Include no file that was not reviewed, and omit the proposal when the repository is not Git-backed or the exact scope is uncertain.

- The user-facing approval is the only authority to create this commit. Submitting a proposal does not authorize Codex to commit it.
- Approval runs in the Qahwa Tasks backend without starting a Codex session. It refuses revision or reviewed-file drift and commits through an isolated Git index so unrelated staged and dirty files remain excluded and preserved.
- Approval never pushes, publishes, or deploys. A successful commit is collected in the project's single active `Publish/deploy changes` Todo for later explicit instructions.
- If approval fails, inspect the reported drift or scope conflict and submit a fresh reviewed output when appropriate. Never broaden the scope to make approval pass.

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
