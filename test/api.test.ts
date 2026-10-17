import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";

test("requires authentication and issues a persistent secure session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-api-"));
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  await new AuthService(database, 365, true).setPassword("correct horse battery staple");
  const app = await buildApp(config, database);
  try {
    const denied = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(denied.statusCode, 401);
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong password value" } });
    assert.equal(wrong.statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery staple" } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"];
    assert.match(String(cookie), /HttpOnly/);
    assert.match(String(cookie), /Secure/);
    const token = String(cookie).split(";", 1)[0];
    const allowed = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: token } });
    assert.equal(allowed.statusCode, 200);
  } finally { await app.close(); }
});

test("configures the first password through a one-use expiring setup token", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-setup-"));
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365, true);
  const { token } = auth.createSetupToken();
  const app = await buildApp(config, database);
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/auth/setup", payload: { token, password: "new secure setup password" },
    });
    assert.equal(setup.statusCode, 200);
    assert.match(String(setup.headers["set-cookie"]), /HttpOnly/);
    const reused = await app.inject({
      method: "POST", url: "/api/auth/setup", payload: { token, password: "new secure setup password" },
    });
    assert.equal(reused.statusCode, 409);
  } finally { await app.close(); }
});
