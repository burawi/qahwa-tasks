import assert from "node:assert/strict";
import test from "node:test";
import { codexAllowance, type CodexUsage } from "../src/domain/codex-usage.js";
import { normalizeCodexLimits } from "../src/server/codex-usage.js";

function allowance(value: unknown) {
  return codexAllowance({ status: "available", data: normalizeCodexLimits(value), updatedAt: null, stale: false });
}

test("battery uses the smallest remaining Codex allowance across real windows, not an average", () => {
  const result = allowance({ rateLimits: { primary: { usedPercent: 15, windowDurationMins: 300 }, secondary: { usedPercent: 80, windowDurationMins: 10080 } } });
  assert.equal(result!.remaining, 20);
  assert.equal(result!.window.windowDurationMins, 10080);
});

test("unrelated model quotas do not replace the Codex allowance", () => {
  const result = allowance({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 26 } }, imagegen: { primary: { usedPercent: 99 } } } });
  assert.equal(result!.remaining, 74);
  assert.equal(result!.bucket, "Codex");
});

test("unknown quotas never imply full or depleted allowance", () => {
  for (const value of [{}, { rateLimits: { primary: { usedPercent: null } } }, { rateLimits: { primary: { usedPercent: -1 } } }, { rateLimitsByLimitId: { one: { primary: { usedPercent: 10 } }, two: { primary: { usedPercent: 80 } } } }]) assert.equal(allowance(value), null);
  assert.equal(codexAllowance({ status: "error", data: null, updatedAt: null, stale: false }), null);
});

test("reported zero, full, exceeded and blocked quotas retain their meanings", () => {
  for (const [usedPercent, remaining] of [[0, 100], [100, 0], [125, 0]]) assert.equal(allowance({ rateLimits: { primary: { usedPercent } } })!.remaining, remaining);
  const blocked = allowance({ rateLimits: { primary: { usedPercent: 26 }, spendControlReached: true } });
  assert.equal(blocked!.remaining, 74); assert.equal(blocked!.reached, true);
});
