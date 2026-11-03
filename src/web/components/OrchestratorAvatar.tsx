import { useState } from "react";
import { Network } from "lucide-react";
import { useOrchestratorAvatar } from "../orchestrator-avatar";

export function OrchestratorAvatar({ preview, large = false, decorative = true }: { preview?: string | null; large?: boolean; decorative?: boolean }) {
  const { source } = useOrchestratorAvatar();
  const url = preview ?? source;
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={`orchestrator-avatar${large ? " large" : ""}`} aria-hidden={decorative || undefined}
    role={decorative ? undefined : "img"} aria-label={decorative ? undefined : "Orchestrator avatar"}>
    {url && failed !== url ? <img src={url} alt="" onError={() => setFailed(url)} /> : <Network />}
  </span>;
}
