import type { Project, RichTextDocument, TaskComment, TaskDetail, TaskStatus, TaskSummary } from "../domain/types";

export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...options.headers } : options.headers,
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) throw new ApiError(body.message ?? "Request failed", body.error ?? "request_failed", response.status);
  return body as T;
}

export const api = {
  authState: () => request<{ authenticated: boolean; configured: boolean }>("/api/auth/state"),
  login: (password: string) => request<{ authenticated: boolean }>("/api/auth/login", {
    method: "POST", body: JSON.stringify({ password }),
  }),
  setup: (password: string, token: string) => request<{ authenticated: boolean; configured: boolean }>("/api/auth/setup", {
    method: "POST", body: JSON.stringify({ password, token }),
  }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  revokeAll: () => request<void>("/api/auth/revoke-all", { method: "POST" }),
  projects: (includeArchived = false) => request<{ projects: Project[] }>(`/api/projects?includeArchived=${includeArchived}`),
  createProject: (body: { name: string; prefix?: string; rootDirectory: string }) =>
    request<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, body: { name?: string; prefix?: string; rootDirectory?: string }) =>
    request<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveProject: (id: string, archived: boolean) => request<{ project: Project }>(`/api/projects/${id}/archive`, {
    method: "POST", body: JSON.stringify({ archived }),
  }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  tasks: (tab: "backlog" | "todo" | "open" | "closed", projectId?: string) => request<{ tasks: TaskSummary[] }>(
    `/api/tasks?tab=${tab}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
  ),
  task: (id: string) => request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (body: { projectId: string; title: string; description: RichTextDocument; status: "backlog" | "todo" }) =>
    request<{ task: TaskDetail }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, body: { title: string; description: RichTextDocument; expectedVersion: number }) =>
    request<{ task: TaskDetail }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  transition: (id: string, to: TaskStatus, outcome?: "completed" | "cancelled") => request<{ task: TaskDetail }>(
    `/api/tasks/${id}/transition`, { method: "POST", body: JSON.stringify({ to, outcome }) },
  ),
  reorder: (id: string, beforeId?: string | null, afterId?: string | null) => request<{ task: TaskDetail }>(
    `/api/tasks/${id}/reorder`, { method: "POST", body: JSON.stringify({ beforeId, afterId }) },
  ),
  deleteTask: (id: string) => request<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  addComment: (id: string, body: RichTextDocument, parentId?: string) => request<{ comment: TaskComment }>(
    `/api/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ body, parentId }) },
  ),
  resolveComment: (id: string, resolved: boolean, reply?: RichTextDocument) => request<{ comment: TaskComment }>(
    `/api/comments/${id}/resolution`, { method: "POST", body: JSON.stringify({ resolved, reply }) },
  ),
  activity: (id: string) => request<{ activity: Array<{ actor: string; eventType: string; createdAt: string }> }>(
    `/api/tasks/${id}/activity`,
  ),
  exportData: () => request<Record<string, unknown>>("/api/export"),
};
