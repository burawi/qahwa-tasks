import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { AppDatabase } from "./database.js";

// Resolve aliases even when the final directory has not been created yet.
export function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  let parent = absolute;
  while (true) {
    try { return join(realpathSync(parent), relative(parent, absolute)); }
    catch { const next = dirname(parent); if (next === parent) return absolute; parent = next; }
  }
}

export function rootsOverlap(first: string, second: string): boolean {
  const a = canonicalRoot(first), b = canonicalRoot(second);
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`) || b.startsWith(a.endsWith("/") ? a : `${a}/`);
}

/** Called inside the same synchronous transaction that reserves execution. */
export function editingBlocker(database: AppDatabase, taskId: string, root: string): string | null {
  const active = database.db.prepare(`SELECT t.human_id, COALESCE(s.active_root_directory,p.root_directory) AS root_directory FROM agent_sessions s
    JOIN tasks t ON t.id=s.owner_id JOIN projects p ON p.id=t.project_id
    WHERE s.owner_type='task' AND t.id!=? AND s.active_access_mode='worktree-write'
      AND (s.run_state IN ('running','waiting') OR s.starting_message_id IS NOT NULL OR s.active_turn_id IS NOT NULL)
    UNION ALL SELECT t.human_id, s.root_directory FROM terminal_sessions s JOIN tasks t ON t.id=s.task_id
    WHERE s.state='running' AND t.id!=?`).all(taskId, taskId) as Array<{ human_id: string; root_directory: string }>;
  return active.find(row => rootsOverlap(root, row.root_directory))?.human_id ?? null;
}
