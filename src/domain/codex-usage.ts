export type UsageStatus = "available" | "unavailable" | "unsupported" | "error";

export interface UsageSection<T> {
  status: UsageStatus;
  data: T | null;
  updatedAt: string | null;
  stale: boolean;
}

export interface CodexLimitWindow {
  kind: "primary" | "secondary";
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexLimitBucket {
  id: string;
  name: string;
  windows: CodexLimitWindow[];
  reached: boolean;
}

export interface CodexUsage {
  limits: UsageSection<CodexLimitBucket[]>;
  tokens: UsageSection<{ lifetimeTokens: number | null; peakDailyTokens: number | null }>;
}

export const CODEX_USAGE_STALE_MS = 5 * 60_000;

export function usageIsStale(section: UsageSection<unknown>, now: number): boolean {
  return section.stale || Boolean(section.updatedAt && now - Date.parse(section.updatedAt) >= CODEX_USAGE_STALE_MS);
}

/** The most constrained reported Codex window, never an average of quotas. */
export function codexAllowance(limits: CodexUsage["limits"]) {
  const buckets = limits.data ?? [];
  const bucket = buckets.find(bucket => bucket.id === "codex") ?? (buckets.length === 1 ? buckets[0] : undefined);
  const window = bucket?.windows.filter(window => window.usedPercent !== null && Number.isFinite(window.usedPercent) && window.usedPercent >= 0)
    .reduce<CodexLimitWindow | null>((tightest, window) => !tightest || window.usedPercent! > tightest.usedPercent! ? window : tightest, null);
  return bucket && window ? { bucket: bucket.name, window, remaining: Math.max(0, Math.min(100, 100 - window.usedPercent!)), reached: bucket.reached } : null;
}
