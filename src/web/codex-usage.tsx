import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { CodexUsage } from "../domain/codex-usage";
import { api } from "./api";

interface UsageContext {
  usage: CodexUsage | null;
  busy: boolean;
  error: string;
  now: number;
  connected: boolean;
  refresh(): Promise<void>;
  revalidate(): void;
  openDetails(): void;
}
const Context = createContext<UsageContext | null>(null);
export const useCodexUsage = () => useContext(Context);

/** One account snapshot shared by every header and the detailed settings panel. */
export function CodexUsageProvider({ connected, onOpenDetails, children }: { connected: boolean; onOpenDetails(): void; children: ReactNode }) {
  const [usage, setUsage] = useState<CodexUsage | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const active = useRef(false), mounted = useRef(false), lastAttempt = useRef(-Infinity);
  const refresh = useCallback(async () => {
    if (!connected || active.current) return;
    active.current = true; lastAttempt.current = Date.now(); setBusy(true); setError("");
    try {
      const result = await api.codexUsage();
      if (mounted.current) { setUsage(result.usage); setNow(Date.now()); }
    } catch { if (mounted.current) setError("Could not load Codex usage. Try Refresh."); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  }, [connected]);
  const revalidate = useCallback(() => {
    if (document.visibilityState === "visible" && Date.now() - lastAttempt.current >= 30_000) void refresh();
  }, [refresh]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (document.visibilityState === "visible") void refresh();
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    // Local aging only; hidden tabs and extra headers create no polling.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(timer); window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [refresh, revalidate]);
  return <Context.Provider value={{ usage, busy, error, now, connected, refresh, revalidate, openDetails: onOpenDetails }}>{children}</Context.Provider>;
}
