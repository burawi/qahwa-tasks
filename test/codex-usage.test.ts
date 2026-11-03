import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexUsageService, normalizeCodexLimits } from "../src/server/codex-usage.js";
import { buildApp } from "../src/server/app.js";
import { AppDatabase } from "../src/server/database.js";
import { AuthService } from "../src/server/auth.js";

function fixture() {
  let now = Date.parse("2026-10-31T21:00:00Z");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const values: Record<string, unknown> = {
    "account/read": { account: { type: "chatgpt", email: "fixture@example.invalid" } },
    "account/rateLimits/read": { rateLimits: { primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: now / 1000 + 3600 } } },
    "account/usage/read": { summary: { lifetimeTokens: 123456789, peakDailyTokens: 9876543 } },
  };
  const service = new CodexUsageService({
    async initialize() { calls.push({ method: "initialize", params: {} }); },
    async request(method, params) { calls.push({ method, params }); const value = values[method]; if (value instanceof Error) throw value; return value; },
  }, () => now);
  return { service, calls, values, advance(ms = 31_000) { now += ms; } };
}

test("limits preserve multiple actual windows and reported percentages without duplicate legacy buckets", () => {
  const buckets = normalizeCodexLimits({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1793484000 }, secondary: { usedPercent: 100, windowDurationMins: 10080 } },
    other: { limitName: "Other model", primary: { usedPercent: 112, windowDurationMins: 15 }, rateLimitReachedType: "rate_limit_reached" },
  } });
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0]!.windows.length, 2);
  assert.equal(buckets[0]!.windows[0]!.usedPercent, 0);
  assert.equal(buckets[0]!.windows[0]!.windowDurationMins, 300);
  assert.equal(buckets[1]!.windows[0]!.usedPercent, 112);
  assert.equal(buckets[1]!.reached, true);
  assert.equal(buckets[0]!.windows[1]!.resetsAt, null);
});

test("null, malformed and missing metrics never become zero or invented window durations", async () => {
  const [bucket] = normalizeCodexLimits({ rateLimits: { primary: { usedPercent: -1, windowDurationMins: 0, resetsAt: 1e20 } } });
  assert.deepEqual(bucket!.windows[0], { kind: "primary", usedPercent: null, windowDurationMins: null, resetsAt: null });
  const f = fixture();
  f.values["account/rateLimits/read"] = { rateLimits: {} };
  f.values["account/usage/read"] = { summary: { lifetimeTokens: null, peakDailyTokens: Number.MAX_SAFE_INTEGER + 1 } };
  const result = await f.service.read();
  assert.equal(result.limits.status, "unavailable");
  assert.equal(result.tokens.status, "unavailable");
  f.advance(); f.values["account/usage/read"] = { summary: { lifetimeTokens: 0 } };
  assert.deepEqual((await f.service.read()).tokens.data, { lifetimeTokens: 0, peakDailyTokens: null });
});

test("concurrent reads coalesce, rapid reads cache, later reads update and only read methods are used", async () => {
  const f = fixture();
  const [one, two] = await Promise.all([f.service.read(), f.service.read()]);
  assert.deepEqual(one, two); assert.equal(f.calls.length, 4);
  await f.service.read(); assert.equal(f.calls.length, 4);
  f.advance(); f.values["account/rateLimits/read"] = { rateLimits: { primary: { usedPercent: 40 } } };
  assert.equal((await f.service.read()).limits.data![0]!.windows[0]!.usedPercent, 40);
  assert.equal(f.calls.length, 8);
  assert.ok(f.calls.every(call => ["initialize", "account/read", "account/rateLimits/read", "account/usage/read"].includes(call.method)));
  assert.ok(f.calls.filter(call => call.method === "account/read").every(call => call.params.refreshToken === false));
  assert.doesNotMatch(JSON.stringify(one), /email|accountId|fixture@example|dailyUsageBuckets/);
});

test("partial errors preserve stale data, sanitize diagnostics, and recover without losing independent sections", async () => {
  const f = fixture(); await f.service.read(); f.advance();
  f.values["account/usage/read"] = new Error("private diagnostic token=secret-value");
  const result = await f.service.read();
  assert.equal(result.limits.status, "available"); assert.equal(result.limits.stale, false);
  assert.equal(result.tokens.status, "error"); assert.equal(result.tokens.stale, true);
  assert.equal(result.tokens.data!.lifetimeTokens, 123456789);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|diagnostic/);
  f.advance(); f.values["account/usage/read"] = { summary: { lifetimeTokens: 200 } };
  assert.equal((await f.service.read()).tokens.stale, false);
});

test("API key and signed-out accounts never request subscription metrics; unsupported RPC is distinct from error", async () => {
  const f = fixture(); f.values["account/read"] = { account: { type: "apiKey" } };
  assert.equal((await f.service.read()).limits.status, "unsupported"); assert.equal(f.calls.length, 2);
  f.advance(); f.values["account/read"] = { account: null };
  assert.equal((await f.service.read()).limits.status, "unavailable");
  f.advance(); f.values["account/read"] = { account: { type: "chatgpt" } };
  f.values["account/usage/read"] = Object.assign(new Error("Method not found"), { code: -32601 });
  const result = await f.service.read(); assert.equal(result.limits.status, "available"); assert.equal(result.tokens.status, "unsupported");
});

test("notifications update global limits, preserve other buckets, and invalidate cached account data", async () => {
  const f = fixture(); await f.service.read();
  f.service.handle({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "other", primary: { usedPercent: 55 } } } });
  const updated = await f.service.read();
  assert.equal(updated.limits.data!.length, 2); assert.equal(updated.limits.data![1]!.windows[0]!.usedPercent, 55);
  assert.equal(f.calls.length, 4);
  f.service.handle({ method: "account/updated" }); f.values["account/read"] = { account: null };
  const cleared = await f.service.read(); assert.equal(cleared.limits.data, null); assert.equal(cleared.tokens.data, null);
});

test("account changes during a request cannot repopulate the previous account's cache", async () => {
  let release!: (value: unknown) => void;
  const service = new CodexUsageService({ async initialize() {}, async request(method) {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "account/usage/read") return new Promise(resolve => { release = resolve; });
    return { rateLimits: { primary: { usedPercent: 23 } } };
  } });
  const pending = service.read();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  service.handle({ method: "account/updated" }); release({ summary: { lifetimeTokens: 123 } });
  const result = await pending; assert.equal(result.tokens.data, null); assert.equal(result.limits.data, null);
});

test("the first authenticated read survives initialization and late account announcements without manual refresh", async () => {
  for (const announceDuring of ["initialize", "account/read"] as const) {
    let service!: CodexUsageService, accountReads = 0;
    service = new CodexUsageService({
      async initialize() { if (announceDuring === "initialize") service.handle({ method: "account/updated" }); },
      async request(method) {
        if (method === "account/read") {
          accountReads++;
          if (announceDuring === "account/read" && accountReads === 1) service.handle({ method: "account/updated" });
          return { account: { type: "chatgpt" } };
        }
        if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 26, windowDurationMins: 10080 } } };
        return { summary: { lifetimeTokens: 12345 } };
      },
    });
    const result = await service.read();
    assert.equal(result.limits.status, "available"); assert.equal(result.tokens.status, "available");
    assert.equal(result.limits.data![0]!.windows[0]!.usedPercent, 26);
    assert.equal(accountReads, announceDuring === "initialize" ? 1 : 2);
  }
});

test("connection loss and passed resets remain stale rather than implying renewed allowance", async () => {
  const f = fixture(); await f.service.read(); f.advance(3_700_000);
  assert.equal((await f.service.read()).limits.stale, true);
  f.service.handle({ method: "qahwa/codex-stopped" }); f.values["account/read"] = new Error("disconnected");
  const result = await f.service.read(); assert.equal(result.limits.stale, true); assert.equal(result.tokens.stale, true);
});

test("usage endpoint requires a paired session, is no-store and exposes only the normalized snapshot", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qahwa-codex-usage-"));
  const config = { host: "127.0.0.1", port: 0, publicBaseUrl: "http://localhost", dataDir: directory, backupDir: join(directory, "backups"), sessionDays: 1 };
  const database = new AppDatabase(config), snapshot = await fixture().service.read();
  let reads = 0;
  t.mock.method(CodexUsageService.prototype, "read", async () => { reads++; return snapshot; });
  const app = await buildApp(config, database);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/settings/codex-usage" })).statusCode, 401); assert.equal(reads, 0);
    const at = new Date().toISOString();
    database.db.prepare("INSERT INTO paired_devices(id,name,public_key,created_at,last_seen_at) VALUES ('usage-test','Usage test','',?,?)").run(at, at);
    const token = new AuthService(database, 1).createSession("usage-test", "127.0.0.1", "usage-test").token;
    const reply = await app.inject({ method: "GET", url: "/api/settings/codex-usage", headers: { authorization: `Bearer ${token}` } });
    assert.equal(reply.statusCode, 200); assert.equal(reply.headers["cache-control"], "no-store"); assert.equal(reads, 1);
    assert.deepEqual(reply.json(), { usage: snapshot });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
