# Qahwa Tasks

Private, mobile-first task coordination between Burawi and persistent Codex sessions.

The app has two surfaces:

- **Tasks** — one project-filterable vertical list. A task is only a note until the user or orchestrator triggers it. Each task then owns a durable Codex thread and chooses chat or an embedded HTML/CSS design canvas.
- **Orchestrator** — one durable portfolio thread for prioritization, capacity-aware parallel starts, and material status updates from task sessions.

Chats render GitHub-flavored Markdown, tables, safe links, and image previews. Task agents maintain the short status and semantic color shown in the list.

## Development

```bash
npm install
npm run auth:set-password
npm run dev
npm run dev:web
```

The backend defaults to `127.0.0.1:3022`; Vite proxies `/api` during development.

## Production

```bash
npm run build
pm2 start deploy/ecosystem.config.cjs
```

The production service is designed for the existing Cloudflare Tunnel route at `tasks.qahwa.pro`. Configure the password locally with `npm run auth:set-password`; credentials, SQLite data, backups and exports are never committed.

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

## Reviewed commit approvals

Coding outputs may carry a commit proposal containing the exact repository root, full base revision, commit message, reviewed repository-relative files, and release note. The Output card exposes all of that information before the user approves it.

Approval is handled directly by the authenticated backend. It rechecks the repository revision and a stored snapshot of every reviewed file, builds the commit with an isolated temporary Git index, and atomically advances `HEAD` only from the reviewed base. Unrelated staged and dirty files are preserved and excluded; Git hooks are disabled for this backend action. The action never starts Codex, pushes, publishes, or deploys.

After a successful commit, Qahwa Tasks creates or updates the project's single active `Publish/deploy changes` Todo, appends the commit and release note, and relates it to the approved source task. Publication and deployment still require separate explicit instructions.

## Notifications

Qahwa Tasks does not send automatic Qahwa Notify alerts for task starts, review submissions, or comments requiring a response. Task status, outputs, and response-required comments remain available in the app. The server and MCP do not process the legacy notification outbox, so previously queued alerts are not sent on startup.

The explicitly invoked `npm run auth:send-setup-link` command can still send an account setup link through Qahwa Notify using `QAHWA_NOTIFY_URL` and `QAHWA_NOTIFY_TOKEN_FILE`.
