import type { TaskSummary } from "../domain/types";

export function normalizeTaskSearch(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Filter the complete scoped list without changing its server-defined order. */
export function searchTasks(tasks: TaskSummary[], query: string): TaskSummary[] {
  const normalized = normalizeTaskSearch(query);
  if (!normalized) return tasks;
  const terms = normalized.split(" ");
  return tasks.filter(task => {
    const fields = [task.title, task.humanId, task.projectName, task.conversation?.descriptionText ?? ""]
      .map(normalizeTaskSearch);
    return terms.every(term => fields.some(field => field.includes(term)));
  });
}
