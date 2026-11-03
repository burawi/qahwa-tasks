import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_SETTINGS, MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH, MAX_ORCHESTRATOR_NAME_LENGTH, parseOrchestratorSettings } from "../src/domain/orchestrator-settings.js";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import { AppDatabase } from "../src/server/database.js";
import { getOrchestratorSettings } from "../src/server/orchestrator-settings.js";

test("orchestrator preferences validate both fields and reject authorization-related fields", () => {
  for (const value of [null, [], {}, { name: " ", customInstructions: "" }, { name: "a\nb", customInstructions: "" },
    { name: "a".repeat(MAX_ORCHESTRATOR_NAME_LENGTH + 1), customInstructions: "" },
    { name: "Companion", customInstructions: 42 },
    { name: "Companion", customInstructions: "a".repeat(MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH + 1) },
    { ...DEFAULT_ORCHESTRATOR_SETTINGS, directive: "start everything" }]) {
    assert.throws(() => parseOrchestratorSettings(value), { code: "invalid_orchestrator_settings" });
  }
  assert.deepEqual(parseOrchestratorSettings({ name: "  قهوة ☕  ", customInstructions: "Line one\n\nLine two" }),
    { name: "قهوة ☕", customInstructions: "Line one\n\nLine two" });
  assert.doesNotThrow(() => parseOrchestratorSettings({ name: "a".repeat(MAX_ORCHESTRATOR_NAME_LENGTH), customInstructions: "a".repeat(MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH) }));
});

test("paired devices share preferences, retain them after cleaning and restart, and reset independently of directives", async () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-preferences-"));
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir: root, backupDir: join(root, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365);
  const stamp = new Date().toISOString();
  const devices = ["phone", "desktop"].map((id) => {
    database.db.prepare("INSERT INTO paired_devices(id, name, public_key, created_at, last_seen_at) VALUES (?, ?, '', ?, ?)").run(id, id, stamp, stamp);
    return { authorization: `Bearer ${auth.createSession(id, "127.0.0.1", id).token}`, origin: config.publicBaseUrl };
  });
  const url = "/api/settings/orchestrator";
  let app = await buildApp(config, database);
  const custom = { name: "قهوة ☕", customInstructions: "Be concise.\nUse plain language." };
  try {
    for (const method of ["GET", "PUT"] as const) {
      assert.equal((await app.inject({ method, url, ...(method === "PUT" ? { payload: custom } : {}) })).statusCode, 401);
    }
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[0] })).json().settings, DEFAULT_ORCHESTRATOR_SETTINGS);
    database.setSetting("orchestrator_standing_directive", "existing directive");
    assert.equal((await app.inject({ method: "PUT", url, headers: { ...devices[0], origin: "https://elsewhere.invalid" }, payload: custom })).statusCode, 403);
    const saved = await app.inject({ method: "PUT", url, headers: devices[0], payload: custom });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().settings, custom);
    assert.equal(database.setting("orchestrator_standing_directive"), "existing directive");
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[1] })).json().settings, custom);
    const invalid = await app.inject({ method: "PUT", url, headers: devices[1], payload: { name: "", customInstructions: "" } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(getOrchestratorSettings(database), custom);
    // Cleaning removes conversation state, while preferences live independently.
    await app.inject({ method: "GET", url: "/api/orchestrator", headers: devices[0] });
    database.db.prepare("INSERT INTO chat_messages(id, owner_type, owner_id, role, body, created_at) VALUES ('old', 'orchestrator', 'main', 'assistant', 'Keep history literal', ?)").run(stamp);
    assert.equal((await app.inject({ method: "POST", url: "/api/orchestrator/clean", headers: devices[1] })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[1] })).json().settings, custom);
    assert.equal((database.db.prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n, 0);
    await app.close();
    const reopened = new AppDatabase(config);
    app = await buildApp(config, reopened);
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[0] })).json().settings, custom);
    reopened.setSetting("orchestrator_standing_directive", "retained directive");
    assert.equal((await app.inject({ method: "PUT", url, headers: devices[1], payload: DEFAULT_ORCHESTRATOR_SETTINGS })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: "GET", url, headers: devices[0] })).json().settings, DEFAULT_ORCHESTRATOR_SETTINGS);
    assert.equal(reopened.setting("orchestrator_standing_directive"), "retained directive");
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
