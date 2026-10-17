import type { CSSProperties } from "react";

const GOLDEN_ANGLE = 137.508;

export function projectHue(projectId: string): number {
  let hash = 2166136261;
  for (const character of projectId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.floor(((hash >>> 0) * GOLDEN_ANGLE) % 360);
}

export function projectColorStyle(projectId: string): CSSProperties {
  return { "--project-hue": String(projectHue(projectId)) } as CSSProperties;
}
