import React, { useEffect, useState } from "react";
import type { ProjectLogo as ProjectLogoType } from "../../domain/types";

export function ProjectLogo({ logo, prefix, size = "medium" }: {
  logo: ProjectLogoType | null;
  prefix: string;
  size?: "small" | "medium" | "large";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logo?.url]);
  return <span className={`project-logo ${size}`} aria-hidden="true">
    {logo && !failed
      ? <img src={logo.url} alt="" onError={() => setFailed(true)} />
      : <span>{prefix.slice(0, size === "small" ? 1 : 3)}</span>}
  </span>;
}
