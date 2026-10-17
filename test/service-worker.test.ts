import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("service worker upgrades stale shell caches without caching HTML navigations", () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

  assert.match(source, /qahwa-tasks-v2/);
  assert.doesNotMatch(source, /STATIC_ASSETS\s*=\s*\[[^\]]*["']\/["']/s);
  assert.match(source, /event\.request\.mode === "navigate"/);
  assert.match(source, /You are offline\. Reconnect and reload to continue\./);
});

test("web builds retain prior content-hashed assets for controlled clients", () => {
  const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(source, /emptyOutDir:\s*false/);
});

test("web delivery keeps recovery files visible and never masks missing assets with HTML", () => {
  const source = readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");

  assert.match(source, /fastifyStatic, \{ root: publicRoot, wildcard: true \}/);
  assert.match(source, /pathname\.startsWith\("\/assets\/"\)/);
  assert.match(source, /asset_not_found/);
  assert.match(source, /pathname === "\/sw\.js"/);
  assert.match(source, /reply\.header\("cache-control", "no-store"\)/);
});
