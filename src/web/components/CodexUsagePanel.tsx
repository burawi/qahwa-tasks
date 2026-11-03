import { RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { usageIsStale, type UsageSection } from "../../domain/codex-usage";
import { useCodexUsage } from "../codex-usage";
import "../codex-usage.css";

function windowLabel(minutes: number | null, kind: string): string {
  if (minutes === null) return `${kind === "primary" ? "Primary" : "Secondary"} window · duration unavailable`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

const dateLabel = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const percent = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

function sectionMessage(section: UsageSection<unknown>, label: string): string | null {
  if (section.status === "unsupported") return `${label} are not supported by this Codex connection.`;
  if (section.status === "unavailable") return `Codex has not reported ${label.toLowerCase()}.`;
  if (section.status === "error") return `Could not refresh ${label.toLowerCase()}. Try Refresh.`;
  return null;
}

export function CodexUsagePanel({ connected, focusOnMount = false }: { connected: boolean; focusOnMount?: boolean }) {
  const state = useCodexUsage();
  const section = useRef<HTMLElement>(null);
  useEffect(() => { state?.revalidate(); }, [state?.revalidate]);
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = requestAnimationFrame(() => { section.current?.scrollIntoView({ block: "start" }); section.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [focusOnMount]);
  if (!state) return null;
  const { usage, busy, error, now, refresh } = state;

  const limits = usage?.limits, tokens = usage?.tokens;
  const staleLimits = Boolean(limits?.data && (!connected || error || usageIsStale(limits, now) || limits.data.some(bucket => bucket.windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= now))));
  const staleTokens = Boolean(tokens?.data && (!connected || error || usageIsStale(tokens, now)));
  return <section ref={section} tabIndex={-1} className="settings-card codex-usage" aria-label="Codex usage and limits" aria-busy={busy}>
    <div className="codex-usage-heading"><div><strong>Codex usage and limits</strong><small>For the signed-in Codex account, across its apps.</small></div>
      <button className="secondary" type="button" disabled={!connected || busy} onClick={() => void refresh()} aria-label="Refresh Codex usage"><RefreshCw aria-hidden="true" />{busy ? "Refreshing…" : "Refresh"}</button>
    </div>
    <div className="codex-usage-content" aria-live="polite">
      {!usage && busy && <p role="status">Loading Codex usage…</p>}
      {!connected && <p role="status">Reconnect to refresh Codex usage.</p>}
      {error && <p className="form-hint error" role="alert">{error}</p>}
      {limits && <div className="codex-usage-limits">
        {staleLimits && <p className="codex-usage-stale">Limits may be out of date. Refresh for the latest report.</p>}
        {sectionMessage(limits, "Usage limits") && <p role="status">{sectionMessage(limits, "Usage limits")}</p>}
        {limits.data?.map(bucket => <div className="codex-usage-bucket" key={bucket.id}>
          <strong>{bucket.name}</strong>
          {bucket.reached && <p>Codex reports a reached usage or spending limit.</p>}
          {!bucket.windows.length && <p>No limit windows reported.</p>}
          {bucket.windows.map(window => <div className="codex-usage-window" key={window.kind}>
            <div className="codex-usage-window-heading"><span>{windowLabel(window.windowDurationMins, window.kind)}</span><strong>{window.usedPercent === null ? "Usage unavailable" : `${percent(Math.max(0, 100 - window.usedPercent))}% remaining`}</strong></div>
            {window.usedPercent !== null && <><progress max={100} value={Math.min(100, window.usedPercent)} aria-label={`${bucket.name} ${windowLabel(window.windowDurationMins, window.kind)} used`} /><small>{percent(window.usedPercent)}% used</small></>}
            <small>{window.resetsAt ? <>Resets <time dateTime={window.resetsAt}>{dateLabel(window.resetsAt)}</time>{Date.parse(window.resetsAt) <= now ? " · awaiting updated report" : ""}</> : "Reset time unavailable"}</small>
          </div>)}
        </div>)}
        {limits.updatedAt && <small>Limits checked <time dateTime={limits.updatedAt}>{dateLabel(limits.updatedAt)}</time></small>}
      </div>}
      {tokens && <div className="codex-usage-tokens">
        {staleTokens && <p className="codex-usage-stale">Token totals may be out of date.</p>}
        {sectionMessage(tokens, "Token totals") && <p role="status">{sectionMessage(tokens, "Token totals")}</p>}
        {tokens.data && <><dl>{tokens.data.lifetimeTokens !== null && <div><dt>Lifetime tokens</dt><dd>{tokens.data.lifetimeTokens.toLocaleString()}</dd></div>}{tokens.data.peakDailyTokens !== null && <div><dt>Peak daily tokens</dt><dd>{tokens.data.peakDailyTokens.toLocaleString()}</dd></div>}</dl><small>Account totals reported by Codex. These do not measure the remaining allowance or this Qahwa task.</small></>}
        {tokens.updatedAt && <small>Tokens checked <time dateTime={tokens.updatedAt}>{dateLabel(tokens.updatedAt)}</time></small>}
      </div>}
    </div>
  </section>;
}
