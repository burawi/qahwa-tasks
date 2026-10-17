import type { Project } from "../domain/types";

export const LAST_CREATE_PROJECT_KEY = "qahwa-tasks.last-create-project";

type PreferenceStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function readLastCreateProjectId(storage?: PreferenceStorage): string | undefined {
  try {
    return (storage ?? window.localStorage).getItem(LAST_CREATE_PROJECT_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function writeLastCreateProjectId(projectId?: string, storage?: PreferenceStorage): void {
  try {
    const target = storage ?? window.localStorage;
    if (projectId) target.setItem(LAST_CREATE_PROJECT_KEY, projectId);
    else target.removeItem(LAST_CREATE_PROJECT_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function preferredCreateProjectId(
  projects: Project[],
  savedProjectId?: string,
  fallbackProjectId?: string,
): string {
  if (savedProjectId && projects.some((project) => project.id === savedProjectId)) return savedProjectId;
  if (fallbackProjectId && projects.some((project) => project.id === fallbackProjectId)) return fallbackProjectId;
  return projects[0]?.id ?? "";
}
