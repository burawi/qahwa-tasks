import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestratorSettings } from "../domain/orchestrator-settings";
import { api } from "./api";

export function useOrchestratorSettings(connected: boolean, serverKey: string) {
  const [state, setState] = useState<{ serverKey: string; settings: OrchestratorSettings | null }>({ serverKey, settings: null });
  const [error, setError] = useState("");
  const revision = useRef(0);
  const accept = useCallback((settings: OrchestratorSettings) => {
    ++revision.current;
    setState({ serverKey, settings });
    setError("");
  }, [serverKey]);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      const startedAt = revision.current;
      try {
        const { settings } = await api.orchestratorSettings();
        if (!stopped && revision.current === startedAt) {
          setState((current) => current.serverKey === serverKey && JSON.stringify(current.settings) === JSON.stringify(settings)
            ? current : { serverKey, settings });
          setError("");
        }
      } catch (error) {
        if (!stopped) setError(error instanceof Error ? error.message : "Could not load orchestrator settings");
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 4_000);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [connected, serverKey]);

  return { settings: state.serverKey === serverKey ? state.settings : null, error, accept };
}
