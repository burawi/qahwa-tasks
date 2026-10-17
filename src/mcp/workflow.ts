import type { TaskService } from "../server/task-service.js";

export function returnTaskToWork(tasks: TaskService, taskId: string) {
  return tasks.transition(taskId, { to: "in_progress" }, "codex");
}

export function addRelatedTask(tasks: TaskService, taskId: string, relatedTaskId: string) {
  return tasks.addRelatedTask(taskId, relatedTaskId, "codex");
}

export function removeRelatedTask(tasks: TaskService, taskId: string, relatedTaskId: string) {
  return tasks.removeRelatedTask(taskId, relatedTaskId, "codex");
}
