import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { UserAvatar } from "../domain/user-avatar";
import { api } from "./api";

interface AvatarState {
  avatar: UserAvatar | null;
  source: string | null;
  loaded: boolean;
  error: string;
  save: (file: File) => Promise<void>;
  reset: () => Promise<void>;
}

const AvatarContext = createContext<AvatarState>({ avatar: null, source: null, loaded: false, error: "",
  save: async () => { throw new Error("Avatar settings are unavailable"); },
  reset: async () => { throw new Error("Avatar settings are unavailable"); },
});

export const useOrchestratorAvatar = () => useContext(AvatarContext);

export function OrchestratorAvatarProvider({ connected, children }: { connected: boolean; children: ReactNode }) {
  const [avatar, setAvatar] = useState<UserAvatar | null>(null);
  const [image, setImage] = useState<{ url: string; source: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const mutating = useRef(false);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      const startedAt = revision.current;
      try {
        if (!mutating.current) {
          const result = await api.orchestratorAvatar();
          if (!stopped && !mutating.current && startedAt === revision.current) {
            setAvatar((current) => current?.version === result.avatar?.version ? current : result.avatar);
            setLoaded(true);
            setError("");
          }
        }
      } catch (error) {
        if (!stopped && !mutating.current && startedAt === revision.current) {
          setError(error instanceof Error ? error.message : "Could not load the orchestrator avatar");
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 4_000);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [connected]);

  // Fetch through the paired encrypted connection once per image revision and
  // share the resulting object URL across Settings, navigation, and the orchestrator chat.
  useEffect(() => {
    if (!avatar) { setImage(null); return; }
    if (!connected || image?.url === avatar.url) return;
    let stopped = false;
    void api.orchestratorAvatarImage(avatar.url).then((blob) => {
      if (stopped) return;
      setImage({ url: avatar.url, source: URL.createObjectURL(blob) });
    }).catch(() => { /* The default icon remains visible if preview loading fails. */ });
    return () => { stopped = true; };
  }, [avatar?.url, connected, image?.url]);
  // Keep a loaded image visible during reconnects, and release it only when
  // replaced, reset, or the paired workspace is unmounted.
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.source); }, [image?.source]);

  const change = async (operation: () => Promise<{ avatar: UserAvatar | null }>) => {
    if (!connected) throw new Error("Connect to save the orchestrator avatar");
    if (mutating.current) throw new Error("The orchestrator avatar is still saving");
    mutating.current = true;
    ++revision.current;
    try {
      const result = await operation();
      setAvatar(result.avatar);
      setLoaded(true);
      setError("");
    } finally { ++revision.current; mutating.current = false; }
  };

  return <AvatarContext.Provider value={{ avatar, loaded, error,
    source: avatar && image?.url === avatar.url ? image.source : null,
    save: (file) => change(() => api.uploadOrchestratorAvatar(file)), reset: () => change(api.resetOrchestratorAvatar),
  }}>{children}</AvatarContext.Provider>;
}
