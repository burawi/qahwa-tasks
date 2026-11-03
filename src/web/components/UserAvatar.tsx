import React, { useState } from "react";
import { UserRound } from "lucide-react";
import { useUserAvatar } from "../user-avatar";

export function UserAvatar({ preview, large = false, decorative = true }: { preview?: string | null; large?: boolean; decorative?: boolean }) {
  const { source } = useUserAvatar();
  const url = preview ?? source;
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={`user-avatar${large ? " large" : ""}`} aria-hidden={decorative || undefined}
    role={decorative ? undefined : "img"} aria-label={decorative ? undefined : "Your avatar"}>
    {url && failed !== url ? <img src={url} alt="" onError={() => setFailed(url)} /> : <UserRound />}
  </span>;
}
