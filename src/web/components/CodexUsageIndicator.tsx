import { codexAllowance, usageIsStale } from "../../domain/codex-usage";
import { useCodexUsage } from "../codex-usage";
import "../codex-usage-indicator.css";

export function CodexUsageIndicator() {
  const state = useCodexUsage();
  if (!state) return null;
  const { usage, busy, connected, error, now, openDetails } = state;
  const limits = usage?.limits;
  const allowance = limits ? codexAllowance(limits) : null;
  const stale = Boolean(allowance && limits && (!connected || error || limits.status !== "available" || usageIsStale(limits, now)
    || limits.data?.some(bucket => bucket.windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= now))));
  const status = stale ? "stale" : !connected ? "offline" : !limits ? busy ? "loading" : "unavailable"
    : error ? "error" : limits.status !== "available" ? limits.status : !allowance ? "unavailable" : allowance.reached ? "limited" : "available";
  const value = allowance?.remaining;
  const label = value === undefined ? status === "loading" ? "…" : "—" : `${stale ? "~" : ""}${Math.floor(value)}%`;
  let description = status === "loading" ? "Loading Codex allowance" : status === "unsupported" ? "Codex allowance is unsupported by this connection"
    : status === "offline" ? "Codex allowance unavailable while offline" : status === "error" ? "Could not refresh Codex allowance" : "Codex allowance unavailable";
  if (allowance) {
    const duration = allowance.window.windowDurationMins;
    const window = duration === null ? "reported window" : duration % 1440 === 0 ? `${duration / 1440}-day window` : duration % 60 === 0 ? `${duration / 60}-hour window` : `${duration}-minute window`;
    description = `${allowance.bucket}: ${value!.toLocaleString(undefined, { maximumFractionDigits: 2 })}% remaining · ${window}`;
    if (stale) description = `Last reported ${description}. Out of date${connected ? "" : "; offline"}`;
    if (allowance.reached) description += ". Codex reports a reached usage or spending limit";
  }
  description += ". Open Codex usage and limits";
  return <button type="button" className="codex-usage-indicator" data-state={status}
    data-level={value !== undefined && (value <= 10 || allowance?.reached) ? "critical" : value !== undefined && value <= 20 ? "low" : "normal"}
    title={description} aria-label={description} onClick={openDetails}>
    <span className="codex-battery" aria-hidden="true"><span className="codex-battery-fill" style={{ width: `${value ?? 0}%` }} /></span>
    <span className="codex-battery-percent" aria-hidden="true">{label}</span>
  </button>;
}
