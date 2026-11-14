import { UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { TeamMember } from "../../domain/types";
import { api } from "../api";

export function TeamAvatar({ member, className = "" }: { member: Pick<TeamMember, "id" | "name" | "avatar">; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true; let objectUrl: string | null = null;
    if (!member.avatar) { setUrl(null); return; }
    void api.memberAvatarImage(member.id).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (active) setUrl(null); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [member.id, member.avatar?.version]);
  return <span className={`team-avatar ${className}`} aria-hidden="true">{url ? <img src={url} alt="" /> : <UserRound />}</span>;
}
