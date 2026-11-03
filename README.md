# Qahwa Tasks

Private, mobile-first task coordination between Burawi and persistent Codex sessions.

The app has two surfaces:

- **Tasks** — one project-filterable vertical list. A task is only a note until the user or orchestrator triggers it. Each task then owns a durable Codex thread and chooses chat or an embedded HTML/CSS design canvas.
- **Orchestrator** — a full Codex session with portfolio awareness: it can research, code, investigate, operate services, and create or manage tasks through the configured tools, alongside prioritization, capacity-aware parallel starts, and material status updates from task sessions.

Chats render GitHub-flavored Markdown, tables, safe links, and image previews. Task agents maintain the short status and semantic color shown in the list.

## Development

```bash
npm install
npm run dev
npm run dev:web
```

The backend defaults to `127.0.0.1:3022`. Create a local one-time pairing link with `npm run pair`.

## Production

```bash
npm run build
pm2 start deploy/ecosystem.config.cjs
```

The production service is designed for the existing Cloudflare Tunnel route at `tasks.qahwa.pro`. Device keys, SQLite data, backups, pairing grants, and exports are never committed.

## Device pairing

The PWA requires the same one-time, server-identity-pinned pairing flow used by Qahwa Design. Create a link on the server:

```bash
npm run pair:production
```

The link is written with mode `0600` under the configured data directory and expires after 15 minutes. Pairing links are server-created only; paired devices can be reviewed and revoked from Projects → Data & access.

## Qahwa Design cutover

The importer is dry-run-first and matches each canvas to a Qahwa Tasks project by its repository root:

```bash
npm run import:qahwa-design
npm run import:qahwa-design -- --apply
```

The apply step creates a SQLite backup first, then preserves the current document, named versions, revision, and Codex thread. Stop the old Qahwa Design service before applying the cutover so two apps do not write to the imported thread.

## Codex integration

The local stdio MCP entry point is:

```bash
node /home/burawi/qahwa-tasks/dist/server/mcp/index.js
```

The companion skill is stored in `skill/qahwa-tasks/SKILL.md` and should be installed into the local Codex skills directory.

App-server sessions inherit the user's configured MCP servers. The orchestrator has full execution access. Task intake always uses read-only execution; ready task sessions have a durable, explicit `read-only` or `worktree-write` access mode independent of intake readiness. Existing unclassified implementations default to exclusive editing. Read-only preparation can read source and return canvas content alongside another task in the same worktree. Editing turns and terminal shells acquire exclusive access across matching, nested, and symlinked project roots. Resource-capacity checks remain in effect. Its role instructions add current projects, task conversations, capacity, and standing directives. The hidden coordination envelope handles session starts, messages, interruptions, priorities, and directives; ordinary Codex tools handle other work. Existing conversations receive updated role instructions and execution settings on resume, preserving their history. Each turn snapshots its access grant before any Codex RPC. Read-only starts, resumes and turns enforce Codex's read-only sandbox with no permission escalation. The task chat's file-access control requests the next mode without starting work. An authorized conversational editing request queues a continuation; it waits for exclusive access before a later turn may edit. Requested modes, optimistic versions and queued messages survive restart and task restoration. Selecting an access mode grants no commit, deployment, publication or closure authority.

## Task idle notifications

Each task chat header has a “Notify when task is idle” switch. It is saved per task and defaults to off for existing and new tasks. Opted-in tasks send a native Qahwa Tasks browser/PWA notification when their active turn completes successfully and becomes idle. Approval/input waits, failed/interrupted turns and orchestrator turns do not send alerts. Automatic start, review and response-required alerts remain disabled.

Enabling a task requests browser notification permission and registers that paired device for Web Push. Each device must grant permission separately; an enabled task offers “Enable on this device” if needed. Notifications use the app icon, arrive through the browser/installed PWA even when the task page is closed, and open the matching task when tapped. Browser and operating-system support and delivery restrictions apply. Revoked devices and expired subscriptions are excluded. Qahwa Notify is not used.

VAPID keys are generated once on first setup and kept in the private application database/backups; only the public key is returned to paired devices. `WEB_PUSH_SUBJECT` can override the contact URL (default `PUBLIC_BASE_URL`). Durable turn receipts, Web Push topics and notification tags suppress duplicates. Delivery has a ten-second timeout per device; failures do not block task execution and are not retried automatically.

## Reviewed commit approvals

Coding outputs may carry a commit proposal containing the exact repository root, full base revision, commit message, reviewed repository-relative files, and release note. The Output card exposes all of that information before the user approves it.

Approval is handled directly by the paired backend. It rechecks the repository revision and a stored snapshot of every reviewed file, builds the commit with an isolated temporary Git index, and atomically advances `HEAD` only from the reviewed base. Unrelated staged and dirty files are preserved and excluded; Git hooks are disabled for this backend action. The action never starts Codex, pushes, publishes, or deploys.

After a successful commit, Qahwa Tasks creates or updates the project's single active `Publish/deploy changes` Todo, appends the commit and release note, and relates it to the approved source task. Publication and deployment still require separate explicit instructions.
