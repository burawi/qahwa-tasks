import type { CodexLimitBucket, CodexLimitWindow, CodexUsage, UsageSection } from "../domain/codex-usage.js";
import { usageIsStale } from "../domain/codex-usage.js";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const tokens = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.slice(0, 160) : null;
const empty = <T>(): UsageSection<T> => ({ status: "unavailable", data: null, updatedAt: null, stale: false });
const timestamp = (value: unknown): string | null => {
  const seconds = number(value);
  return seconds !== null && seconds * 1000 <= 8.64e15 ? new Date(seconds * 1000).toISOString() : null;
};

export function normalizeCodexLimits(value: unknown): CodexLimitBucket[] {
  const response = object(value);
  const byId = Object.entries(object(response.rateLimitsByLimitId));
  const legacy = object(response.rateLimits);
  const entries = byId.length ? byId : Object.keys(legacy).length ? [[text(legacy.limitId) ?? "codex", legacy] as const] : [];
  return entries.map(([key, value]) => {
    const bucket = object(value);
    const windows: CodexLimitWindow[] = [];
    for (const kind of ["primary", "secondary"] as const) {
      if (!bucket[kind] || typeof bucket[kind] !== "object") continue;
      const window = object(bucket[kind]);
      const duration = number(window.windowDurationMins);
      windows.push({ kind, usedPercent: number(window.usedPercent), windowDurationMins: duration && duration > 0 ? duration : null, resetsAt: timestamp(window.resetsAt) });
    }
    return { id: key, name: text(bucket.limitName) ?? (key === "codex" ? "Codex" : key), windows,
      reached: Boolean(bucket.rateLimitReachedType) || bucket.spendControlReached === true };
  });
}

export interface UsageCodexConnection {
  initialize(): Promise<void>;
  request(method: string, params: JsonObject): Promise<unknown>;
}

// One shared connection, no turns, no authentication changes, and no background polling.
export class CodexUsageService {
  private snapshot: CodexUsage = { limits: empty(), tokens: empty() };
  private pending: Promise<CodexUsage> | null = null;
  private lastRead = -Infinity;
  private generation = 0;
  private identity: string | null = null;

  constructor(private readonly connection: UsageCodexConnection, private readonly now = Date.now) {}

  handle(message: JsonObject): void {
    if (message.method === "account/updated") {
      this.generation++;
      this.identity = null;
      this.snapshot = { limits: empty(), tokens: empty() };
      this.lastRead = -Infinity;
    } else if (message.method === "qahwa/codex-stopped") {
      this.generation++;
      this.snapshot.limits.stale = Boolean(this.snapshot.limits.data);
      this.snapshot.tokens.stale = Boolean(this.snapshot.tokens.data);
      this.lastRead = -Infinity;
    } else if (message.method === "account/rateLimits/updated" && this.identity) {
      const incoming = normalizeCodexLimits(message.params);
      if (!incoming.length) return;
      const buckets = new Map((this.snapshot.limits.data ?? []).map(bucket => [bucket.id, bucket]));
      for (const bucket of incoming) buckets.set(bucket.id, bucket);
      this.snapshot.limits = { status: "available", data: [...buckets.values()], updatedAt: new Date(this.now()).toISOString(), stale: false };
    }
  }

  read(): Promise<CodexUsage> {
    if (this.pending) return this.pending;
    // Coalesce clients and rapid refresh clicks, including errors.
    if (this.now() - this.lastRead < 30_000) return Promise.resolve(this.view());
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  private view(): CodexUsage {
    const limits = { ...this.snapshot.limits, stale: usageIsStale(this.snapshot.limits, this.now()) };
    if (limits.data?.some(bucket => bucket.windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= this.now()))) limits.stale = true;
    return { limits, tokens: { ...this.snapshot.tokens, stale: usageIsStale(this.snapshot.tokens, this.now()) } };
  }

  private async refresh(): Promise<CodexUsage> {
    let generation = this.generation;
    this.lastRead = this.now();
    try {
      await this.connection.initialize();
      // Initialization may announce the already signed-in account. Start the
      // guarded read after that announcement, and retry once if it arrives late.
      generation = this.generation;
      let account = object(object(await this.connection.request("account/read", { refreshToken: false })).account);
      if (generation !== this.generation) {
        generation = this.generation;
        account = object(object(await this.connection.request("account/read", { refreshToken: false })).account);
      }
      if (generation !== this.generation) return this.view();
      const type = text(account.type);
      const identity = JSON.stringify([type, account.id, account.email]);
      if (this.identity !== identity) this.snapshot = { limits: empty(), tokens: empty() };
      this.identity = identity;
      if (type !== "chatgpt") {
        const status = type ? "unsupported" : "unavailable";
        this.snapshot = { limits: { ...empty(), status }, tokens: { ...empty(), status } };
        return this.view();
      }
      await Promise.all([
        this.fetch("limits", "account/rateLimits/read", normalizeCodexLimits, generation),
        this.fetch("tokens", "account/usage/read", value => {
          const summary = object(object(value).summary);
          const lifetimeTokens = tokens(summary.lifetimeTokens), peakDailyTokens = tokens(summary.peakDailyTokens);
          return lifetimeTokens !== null || peakDailyTokens !== null ? { lifetimeTokens, peakDailyTokens } : null;
        }, generation),
      ]);
    } catch {
      if (generation === this.generation) for (const section of [this.snapshot.limits, this.snapshot.tokens]) {
        section.status = "error";
        section.stale = Boolean(section.data);
      }
    }
    return this.view();
  }

  private async fetch<K extends keyof CodexUsage>(key: K, method: string, normalize: (value: unknown) => CodexUsage[K]["data"], generation: number): Promise<void> {
    try {
      const value = await this.connection.request(method, {});
      if (generation !== this.generation) return;
      const data = normalize(value);
      const available = Array.isArray(data) ? data.length > 0 : data !== null;
      this.snapshot[key] = { status: available ? "available" : "unavailable", data: available ? data : null, updatedAt: new Date(this.now()).toISOString(), stale: false } as CodexUsage[K];
    } catch (error) {
      if (generation !== this.generation) return;
      const previous = this.snapshot[key];
      const message = error instanceof Error ? error.message : "";
      const unsupported = (error as { code?: unknown })?.code === -32601 || /method not found|unknown method|unsupported|not supported|requires.*(?:auth|chatgpt)|only.*chatgpt/i.test(message);
      this.snapshot[key] = { ...previous, status: unsupported ? "unsupported" : "error", stale: Boolean(previous.data) };
    }
  }
}
