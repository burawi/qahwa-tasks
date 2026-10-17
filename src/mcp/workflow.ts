import type { TaskService } from "../server/task-service.js";

export function returnTaskToWork(tasks: TaskService, taskId: string) {
  return tasks.transition(taskId, { to: "in_progress" }, "codex");
}
