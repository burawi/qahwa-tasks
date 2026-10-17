import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";

test("service worker purges poisoned caches and leaves release assets to HTTP caching", () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

  assert.match(source, /qahwa-tasks-v4/);
  assert.doesNotMatch(source, /STATIC_ASSETS\s*=\s*\[[^\]]*["']\/["']/s);
  assert.match(source, /event\.request\.mode === "navigate"/);
  assert.match(source, /legacyCaches\.length > 0/);
  assert.match(source, /client\.navigate\(client\.url\)/);
  assert.match(source, /STATIC_ASSETS\.includes\(url\.pathname\)/);
  assert.doesNotMatch(source, /cache\.put\(event\.request/);
  assert.match(source, /You are offline\. Reconnect and reload to continue\./);
});

test("web builds retain prior content-hashed assets for controlled clients", () => {
  const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(source, /emptyOutDir:\s*false/);
});

test("web delivery uses executable recovery responses for retired release hashes", () => {
  const source = readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");

  assert.match(source, /fastifyStatic, \{ root: publicRoot, wildcard: true \}/);
  assert.match(source, /pathname\.startsWith\("\/assets\/"\)/);
  assert.match(source, /legacyScriptRecovery/);
  assert.match(source, /application\/javascript/);
  assert.match(source, /retired release stylesheet/);
  assert.match(source, /asset_not_found/);
  assert.match(source, /pathname === "\/sw\.js"/);
  assert.match(source, /reply\.header\("cache-control", "no-store"\)/);
});

test("unknown historical script and stylesheet hashes recover with safe MIME types", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-recovery-"));
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020",
    qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const app = await buildApp(config, new AppDatabase(config));
  try {
    const script = await app.inject({ method: "GET", url: "/assets/index-retired.js" });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers["content-type"], /^application\/javascript/);
    assert.equal(script.headers["cache-control"], "no-store");
    assert.match(script.body, /location\.replace/);

    const stylesheet = await app.inject({ method: "GET", url: "/assets/index-retired.css" });
    assert.equal(stylesheet.statusCode, 200);
    assert.match(stylesheet.headers["content-type"], /^text\/css/);
    assert.equal(stylesheet.headers["cache-control"], "no-store");

    const other = await app.inject({ method: "GET", url: "/assets/retired.png" });
    assert.equal(other.statusCode, 404);
  } finally { await app.close(); }
});
