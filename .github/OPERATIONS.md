# Run your own workspace

[← Back to Qahwa Tasks](../README.md)

Qahwa's server, project worktrees, and Codex sessions live on the same host. The browser is a paired client. Keep the host's project access and configured tools in mind when choosing who can pair.

## Build and run

```bash
npm ci
npm run build
npm start
```

The backend defaults to loopback port `3022`. Serve it behind an HTTPS reverse proxy for remote access and browser features that require a secure context. Set `PUBLIC_BASE_URL` to the address your clients use.

Configuration comes from process environment variables; copying `.env.example` alone does not load them. The supplied environment example and `deploy/ecosystem.config.cjs` describe the original installation. Replace its domain, absolute checkout path, data directory, and backup directory before using it on another host.

## Pair a browser

Run this on the host using the same environment as the application:

```bash
npm run pair
```

The one-time link is written under the configured data directory with mode `0600` and expires after 15 minutes. Use the application's pairing screen to connect. Do not put pairing links in issues, screenshots, or logs shared publicly.

`npm run pair:production` is a convenience command for the original installation with hardcoded host settings. Use `npm run pair` with your own environment on another host.

Review and revoke paired devices from **Projects → Data & access**.

## Data and backups

Application state uses SQLite and local files under `DATA_DIR`. Backups default to `<DATA_DIR>/backups`; override `BACKUP_DIR` if you keep them elsewhere.

```bash
npm run backup
```

Use the same data configuration for the running app, pairing, and backup commands. Keep database files, uploads, device keys, grants, exports, and backups private. The repository's ignore rules exclude runtime storage and local evidence.

## Codex and task access

The backend launches `codex app-server` and uses the host's Codex configuration. Sessions inherit configured MCP servers. Install and configure the CLI on the host before starting agent work.

For task coordination, the built stdio MCP entry point is:

```bash
node /absolute/path/to/qahwa-tasks/dist/server/mcp/index.js
```

The companion skill lives in [skill/qahwa-tasks/SKILL.md](../skill/qahwa-tasks/SKILL.md).

Task intake is read-only. Ready task sessions use explicit `read-only` or `worktree-write` access. Editing turns and terminal shells acquire exclusive access to overlapping project roots. Resource-capacity checks also apply. A file-access grant does not authorize commits, pushes, deployment, publication, or task closure.

## Notifications

Each task can opt into an idle notification. Enabling it requests browser permission and registers that device for Web Push. Permissions are per device; browser and operating-system delivery restrictions apply.

VAPID keys are generated during setup and stored in private application data. `WEB_PUSH_SUBJECT` overrides the contact URL, which otherwise defaults to `PUBLIC_BASE_URL`. Notifications open the matching task when tapped.

## Qahwa Design migration

The importer is dry-run-first and matches canvases to projects by repository root:

```bash
npm run import:qahwa-design
```

Review its output before choosing to apply a migration. The apply path creates a SQLite backup first. Stop the old service before a cutover so both applications cannot write to the same imported thread.
