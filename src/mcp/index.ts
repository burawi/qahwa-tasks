import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { documentFromPlainText, documentFromSections, plainTextFromDocument } from "../domain/types.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/database.js";
import { NotificationWorker } from "../server/notification-worker.js";
import { QahwaNotifier } from "../server/notifier.js";
import { TaskService } from "../server/task-service.js";

const config = loadConfig();
const database = new AppDatabase(config);
const tasks = new TaskService(database);
const notifications = new NotificationWorker(database, new QahwaNotifier(config));
const server = new McpServer({ name: "qahwa-tasks", version: "1.0.0" });

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const compactTask = (task: ReturnType<TaskService["getTask"]>) => ({
  id: task.humanId,
  title: task.title,
  project: task.projectName,
  rootDirectory: task.rootDirectory,
  status: task.status,
  outcome: task.outcome,
  version: task.version,
  description: plainTextFromDocument(task.description),
  unresolvedComments: task.comments.filter((comment) => !comment.resolvedAt).map((comment) => ({
    id: comment.id,
    author: comment.author,
    text: comment.plainText,
    replies: comment.replies.map((reply) => ({ id: reply.id, author: reply.author, text: reply.plainText })),
  })),
  latestHandoff: task.latestHandoff ? { text: task.latestHandoff.plainText, metadata: task.latestHandoff.metadata } : null,
});

server.registerTool("list_projects", {
  description: "List active Qahwa Tasks projects and their local root directories.",
  inputSchema: { includeArchived: z.boolean().optional() },
  annotations: { readOnlyHint: true },
}, ({ includeArchived }) => text(tasks.listProjects(includeArchived ?? false)));

server.registerTool("create_project", {
  description: "Create a project after the user has explicitly requested it. The root directory must already exist.",
  inputSchema: { name: z.string().min(1).max(80), prefix: z.string().min(2).max(6).optional(), rootDirectory: z.string().min(1) },
}, ({ name, prefix, rootDirectory }) => text(tasks.createProject({ name, prefix, rootDirectory }, "codex")));

server.registerTool("list_tasks", {
  description: "List tasks compactly by app tab, in global priority order.",
  inputSchema: {
    tab: z.enum(["backlog", "todo", "open", "closed"]),
    projectId: z.string().optional(),
  },
  annotations: { readOnlyHint: true },
}, ({ tab, projectId }) => {
  const summaries = tasks.listTasks({ tab, projectId }).map((task) => ({
    id: task.humanId, title: task.title, project: task.projectName, status: task.status,
    outcome: task.outcome, unresolvedComments: task.unresolvedCommentCount,
  }));
  return text(summaries);
});

server.registerTool("get_task", {
  description: "Load one task with its current description, unresolved comments, latest handoff and project root. Resolved history is omitted by default to protect context.",
  inputSchema: { taskId: z.string(), includeResolvedHistory: z.boolean().optional() },
  annotations: { readOnlyHint: true },
}, ({ taskId, includeResolvedHistory }) => text(compactTask(tasks.getTask(taskId, includeResolvedHistory ?? false))));

const taskSections = {
  goal: z.string().optional(),
  details: z.union([z.string(), z.array(z.string())]).optional(),
  doneWhen: z.array(z.string()).optional(),
};

server.registerTool("create_tasks", {
  description: "Create one or more Codex-authored tasks at the bottom of Backlog or Todo using the Goal, Details, Done when structure.",
  inputSchema: {
    projectId: z.string(),
    status: z.enum(["backlog", "todo"]).default("backlog"),
    tasks: z.array(z.object({ title: z.string().min(1).max(200), ...taskSections })).min(1).max(50),
  },
}, ({ projectId, status, tasks: inputs }) => text(inputs.map((input) => tasks.createTask({
  projectId, status, title: input.title, sections: { goal: input.goal, details: input.details, doneWhen: input.doneWhen },
}, "codex")).map((task) => ({ id: task.humanId, title: task.title, status: task.status }))));

server.registerTool("update_task", {
  description: "Update a task title and/or structured description. Requires the current version to prevent overwriting user edits.",
  inputSchema: {
    taskId: z.string(), expectedVersion: z.number().int().positive(), title: z.string().min(1).max(200).optional(),
    goal: z.string().optional(), details: z.union([z.string(), z.array(z.string())]).optional(), doneWhen: z.array(z.string()).optional(),
  },
}, ({ taskId, expectedVersion, title, goal, details, doneWhen }) => {
  const current = tasks.getTask(taskId);
  const hasSections = goal !== undefined || details !== undefined || doneWhen !== undefined;
  const description = hasSections ? documentFromSections([
    { heading: "Goal", body: goal ?? "" }, { heading: "Details", body: details ?? "" }, { heading: "Done when", body: doneWhen ?? [] },
  ]) : current.description;
  return text(compactTask(tasks.updateTask(current.id, { title, description, expectedVersion }, "codex")));
});

server.registerTool("move_to_todo", {
  description: "Promote a Backlog task to Todo. This does not start work.",
  inputSchema: { taskId: z.string() },
}, ({ taskId }) => text(compactTask(tasks.transition(taskId, { to: "todo" }, "codex"))));

server.registerTool("start_task", {
  description: "Move a Todo task to in-progress immediately before beginning work. This queues a Qahwa Notify alert.",
  inputSchema: { taskId: z.string() },
}, async ({ taskId }) => {
  const result = tasks.transition(taskId, { to: "in_progress" }, "codex");
  await notifications.process();
  return text(compactTask(result));
});

server.registerTool("add_comment", {
  description: "Add a Codex comment or reply. Set requiresResponse only when the user must answer or approve; that setting sends a notification.",
  inputSchema: { taskId: z.string(), text: z.string().min(1), parentId: z.string().optional(), requiresResponse: z.boolean().optional() },
}, async ({ taskId, text: body, parentId, requiresResponse }) => {
  const result = tasks.addComment(taskId, { body: documentFromPlainText(body), parentId, requiresResponse }, "codex");
  if (requiresResponse) await notifications.process();
  return text({ id: result.id, text: result.plainText, requiresResponse: result.requiresResponse });
});

server.registerTool("resolve_comment", {
  description: "Resolve or reopen a comment thread, optionally adding a concise reply explaining the resolution.",
  inputSchema: { commentId: z.string(), resolved: z.boolean().default(true), reply: z.string().optional() },
}, ({ commentId, resolved, reply }) => text(tasks.resolveComment(
  commentId, resolved, "codex", reply ? documentFromPlainText(reply) : undefined,
)));

server.registerTool("submit_for_review", {
  description: "Add a compact Codex handoff and move an in-progress task to in-review. This queues a Qahwa Notify alert.",
  inputSchema: {
    taskId: z.string(), sessionId: z.string().optional(), runId: z.string().optional(), summary: z.string().min(1),
    validation: z.array(z.string()).optional(), commit: z.string().optional(), limitations: z.array(z.string()).optional(),
  },
}, async ({ taskId, sessionId, runId, summary, validation, commit, limitations }) => {
  const result = tasks.submitForReview(taskId, {
    sessionId: sessionId ?? process.env.CODEX_THREAD_ID, runId, summary, validation, commit, limitations,
  }, "codex");
  await notifications.process();
  return text(compactTask(result));
});

server.registerTool("return_to_work", {
  description: "Move a task from in-review back to in-progress when review feedback requires changes.",
  inputSchema: { taskId: z.string() },
}, ({ taskId }) => text(compactTask(tasks.transition(taskId, { to: "in_progress" }, "codex"))));

server.registerTool("close_task", {
  description: "Close a task only after the user explicitly instructs Codex to complete or cancel this specific task. Never infer permission.",
  inputSchema: {
    taskId: z.string(), outcome: z.enum(["completed", "cancelled"]),
    explicitUserInstruction: z.string().min(3).describe("The user's explicit instruction authorizing closure of this task"),
  },
}, ({ taskId, outcome, explicitUserInstruction }) => text(compactTask(tasks.transition(
  taskId, { to: "closed", outcome, explicitUserInstruction }, "codex",
))));

const transport = new StdioServerTransport();
transport.onerror = (error) => console.error("Qahwa Tasks MCP transport error", error);
await server.connect(transport);

process.on("SIGINT", async () => { database.close(); process.exit(0); });
process.on("SIGTERM", async () => { database.close(); process.exit(0); });
