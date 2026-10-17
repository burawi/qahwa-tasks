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

## Local frontend review previews

Previewable frontend work can be attached to a structured task output as a local review environment. A preview must use representative mock data, contain no production credentials, and avoid production mutations. It is not a deployment.

1. Start the project's documented frontend command on an explicit review port and bind it to the interface required for Tailscale access. Record the exact command and the owning Codex session, process manager entry, or PID file.
2. Build the URL from the machine's approved Tailscale DNS name or address. Qahwa Tasks accepts tailnet `*.ts.net` names, Tailscale IPv4 addresses in `100.64.0.0/10`, and Tailscale IPv6 addresses in `fd7a:115c:a1e0::/48`.
3. Check the page locally, then open the exact URL from another authorized Tailscale device. Submit the output with `preview.availability` set to `available` and an ISO-8601 `checkedAt` only after both checks succeed.
4. After a revision, refresh or restart the owned process, repeat both checks, and submit the current metadata. Use `stopped`, `failed`, or `unreachable` when appropriate; unavailable previews render without an active Open action.
5. When review is over, stop only the recorded process through its process manager or exact PID. Do not use broad process-kill commands. Record the stopped state in a later output if the task remains active.

Example structured preview metadata:

```json
{
  "url": "https://workstation.example-tailnet.ts.net:4173/",
  "startCommand": "npm run preview -- --host 0.0.0.0 --port 4173",
  "processOwner": "Codex session <session-id>",
  "availability": "available",
  "checkedAt": "2026-10-17T09:00:00.000Z"
}
```
