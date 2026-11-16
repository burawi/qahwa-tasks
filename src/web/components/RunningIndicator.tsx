import "../running-indicator.css";

/** Keep the slot mounted so state changes never move adjacent text or badges. */
export function RunningIndicator({ running, label = "Running" }: { running: boolean; label?: string }) {
  return <span className="running-indicator" data-running={running}
    role={running ? "img" : undefined} aria-label={running ? label : undefined}
    aria-hidden={running ? undefined : true} title={running ? label : undefined}>
    <span /><span /><span />
  </span>;
}
