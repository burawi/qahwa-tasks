import React, { useEffect, useState } from "react";
import type { ProjectLogo as ProjectLogoType } from "../../domain/types";
import { fetchEncryptedAsset } from "../api";

export function ProjectLogo({ logo, prefix, size = "medium" }: {
  logo: ProjectLogoType | null;
  prefix: string;
  size?: "small" | "medium" | "large";
}) {
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    setFailed(false);
    setSource(null);
    if (!logo) return;
    let disposed = false;
    let objectUrl: string | null = null;
    void fetchEncryptedAsset(logo.url).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(() => setFailed(true));
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [logo?.url]);
  return <span className={`project-logo ${size}`} aria-hidden="true">
    {logo && source && !failed
      ? <img src={source} alt="" onError={() => setFailed(true)} />
      : <span>{prefix.slice(0, size === "small" ? 1 : 3)}</span>}
  </span>;
}
