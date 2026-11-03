import type { TaskComment } from "./types.js";

export interface CanvasCommentTarget {
  elementId: string;
  label: string;
}

export interface CanvasCommentAnchor extends CanvasCommentTarget {
  /** A shared thread's targets. The primary fields retain legacy compatibility. */
  targets?: CanvasCommentTarget[];
  revision: number;
  pageId?: string;
  /** Retained only for legacy comment provenance. */
  versionId?: string;
}

export function canvasCommentAnchor(comment: Pick<TaskComment, "metadata">): CanvasCommentAnchor | null {
  const value = comment.metadata?.canvas as Partial<CanvasCommentAnchor> | undefined;
  return value && typeof value.elementId === "string" && typeof value.label === "string"
    && (value.targets === undefined || (Array.isArray(value.targets) && value.targets.length > 0
      && value.targets.every(target => target && typeof target.elementId === "string" && typeof target.label === "string")
      && new Set(value.targets.map(target => target.elementId)).size === value.targets.length
      && value.targets[0]!.elementId === value.elementId && value.targets[0]!.label === value.label))
    && Number.isInteger(value.revision) && (typeof value.pageId === "string" || typeof value.versionId === "string")
    ? value as CanvasCommentAnchor : null;
}

export function canvasCommentTargets(anchor: CanvasCommentAnchor): CanvasCommentTarget[] {
  return anchor.targets ?? [{ elementId: anchor.elementId, label: anchor.label }];
}
