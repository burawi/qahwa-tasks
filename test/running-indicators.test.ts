import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { AuthService } from "../src/server/auth.js";
import { buildApp } from "../src/server/app.js";
import type { Config } from "../src/server/config.js";

test("navigation poll reports actual orchestrator state without opening history or marking replies read", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-running-"));
  const config: Config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir, backupDir: join(dataDir, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES ('browser', 'Browser', '', 'now', 'now')").run();
  const token = new AuthService(database, 365).createSession("test", "127.0.0.1", "browser").token;
  const headers = { authorization: `Bearer ${token}`, origin: config.publicBaseUrl };
  const app = await buildApp(config, database);
  const poll = async () => {
    const reply = await app.inject({ method: "GET", url: "/api/orchestrator/unread", headers });
    assert.equal(reply.statusCode, 200);
    return reply.json();
  };
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/orchestrator/unread" })).statusCode, 401);
    database.db.prepare("DELETE FROM agent_sessions").run();
    assert.equal((await poll()).sessionState, "not_started");
    assert.equal((database.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get() as { n: number }).n, 0);
    database.db.prepare("INSERT INTO agent_sessions (id, owner_type, owner_id, run_state, created_at, updated_at) VALUES ('s', 'orchestrator', 'main', 'idle', 'now', 'now')").run();
    database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES ('queued', 'orchestrator', 'main', 'user', 'Queued work', 'now')").run();
    database.db.prepare("INSERT INTO chat_messages (id, owner_type, owner_id, role, body, created_at) VALUES ('reply', 'orchestrator', 'main', 'assistant', 'Unread reply', 'now')").run();
    database.db.prepare("INSERT INTO pending_messages (message_id, retry_after) VALUES ('queued', '2099-01-01T00:00:00.000Z')").run();
    for (const state of ["idle", "running", "waiting", "running", "interrupted", "running", "failed", "running", "idle", "not_started"]) {
      database.db.prepare("UPDATE agent_sessions SET run_state = ? WHERE id = 's'").run(state);
      const result = await poll();
      assert.equal(result.sessionState, state);
      assert.deepEqual(result.readState, { unreadCount: 1, unreadMessageIds: ["reply"] });
      assert.deepEqual(Object.keys(result).sort(), ["readState", "sessionState"]);
    }
  } finally { await app.close(); }
});
