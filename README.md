# Qahwa Tasks

Private, mobile-first task coordination between Burawi and Codex.

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
