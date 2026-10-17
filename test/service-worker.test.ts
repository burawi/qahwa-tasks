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
