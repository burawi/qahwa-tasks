import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";

test("service worker purges Cache Storage and bypasses poisoned immutable HTTP CSS", () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

  assert.match(source, /qahwa-tasks-v13/);
  assert.doesNotMatch(source, /STATIC_ASSETS\s*=\s*\[[^\]]*["']\/["']/s);
  assert.match(source, /event\.request\.mode === "navigate"/);
  assert.match(source, /legacyCaches\.length > 0/);
  assert.doesNotMatch(source, /await .*client\.navigate/);
  assert.match(source, /searchParams\.get\("recovery"\) === "v13"/);
  assert.match(source, /recoveryUrl\.searchParams\.set\("recovery", "v13"\)/);
  assert.match(source, /client\.navigate\(recoveryUrl\.toString\(\)\)\.catch/);
  assert.match(source, /STATIC_ASSETS\.includes\(url\.pathname\)/);
  assert.match(source, /url\.pathname\.endsWith\("\.css"\)/);
  assert.match(source, /url\.searchParams\.set\("qahwa-style", STYLE_RECOVERY\)/);
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
  assert.match(source, /currentStylesheetPath/);
  assert.match(source, /asset_not_found/);
  assert.match(source, /pathname === "\/sw\.js"/);
  assert.match(source, /pathname === "\/boot\.js"/);
  assert.match(source, /reply\.header\("cache-control", "no-store"\)/);
});

test("pre-bundle guard recovers once and makes bootstrap failures visible", () => {
  const source = readFileSync(new URL("../public/boot.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

  assert.match(html, /<script src="\/boot\.js\?v=12"><\/script>/);
  assert.match(source, /api\/client-diagnostics/);
  assert.match(source, /getRegistrations/);
  assert.match(source, /qahwa-tasks-/);
  assert.match(source, /showRecovery/);
  assert.match(source, /bootstrap-timeout/);
  assert.match(source, /target\.tagName === "SCRIPT"/);
  assert.match(source, /\.origin === location\.origin/);
  assert.match(source, /link\[rel="stylesheet"\]\[href\]/);
  assert.match(source, /searchParams\.set\("qahwa-style", "v13"\)/);
});

test("unknown historical script and stylesheet hashes recover with safe MIME types", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-recovery-"));
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365,
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
    const html = readFileSync(new URL("../dist/public/index.html", import.meta.url), "utf8");
    const currentHref = html.match(/href="(\/assets\/[A-Za-z0-9_.-]+\.css)"/)?.[1];
    assert.ok(currentHref);
    assert.equal(stylesheet.body, readFileSync(new URL(`../dist/public${currentHref}`, import.meta.url), "utf8"));
    assert.ok(stylesheet.body.length > 1_000);

    const other = await app.inject({ method: "GET", url: "/assets/retired.png" });
    assert.equal(other.statusCode, 404);

    const boot = await app.inject({ method: "GET", url: "/boot.js?v=7" });
    assert.equal(boot.statusCode, 200);
    assert.equal(boot.headers["cache-control"], "no-store");

  } finally { await app.close(); }
});
