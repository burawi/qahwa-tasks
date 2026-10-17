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
