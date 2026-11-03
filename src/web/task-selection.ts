import type { SelectedTaskReference } from "../domain/types";

export function taskSelectionKey(server = "local", device = "browser"): string {
  return `qahwa-task-selection-v1:${server}:${device}`;
}

export function readTaskSelection(key: string, storage?: Pick<Storage, "getItem">): SelectedTaskReference[] {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    const unique = new Map<string, SelectedTaskReference>();
    for (const entry of value) {
      if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.humanId !== "string" || typeof entry.title !== "string") continue;
      unique.set(entry.id, { id: entry.id, humanId: entry.humanId, title: entry.title });
    }
    return [...unique.values()];
  } catch { return []; }
}

export function writeTaskSelection(key: string, tasks: SelectedTaskReference[], storage?: Pick<Storage, "setItem">): void {
  try { (storage ?? localStorage).setItem(key, JSON.stringify(tasks)); } catch { /* Selection still works if storage is unavailable. */ }
}

export function toggleTaskSelection(tasks: SelectedTaskReference[], task: SelectedTaskReference): SelectedTaskReference[] {
  return tasks.some(({ id }) => id === task.id)
    ? tasks.filter(({ id }) => id !== task.id)
    : [...tasks, { id: task.id, humanId: task.humanId, title: task.title }];
}
