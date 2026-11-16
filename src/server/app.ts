import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { workspacePoll } from "./workspace-poll.js";
import { MessageReadService } from "./message-read-service.js";
import type { WorkspaceCursor, MessagePageQuery } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import { MAX_PROJECT_LOGO_BYTES, PROJECT_LOGO_SIZE_ERROR } from "../domain/project-logo.js";
import type { RichTextDocument, TaskStatus } from "../domain/types.js";
import { AuthService } from "./auth.js";
import { VoiceService } from "./voice-service.js";
import type { Config } from "./config.js";
import { AppDatabase } from "./database.js";
import { TaskService } from "./task-service.js";
import { TaskCreationService, type TaskCreationInput } from "./task-creation-service.js";
import { AgentService } from "./agent-service.js";
import { TaskIdleNotifier } from "./task-idle-notifier.js";
import { AppPushService } from "./app-push-service.js";
import { PairingService } from "./pairing.js";
import { ATTACHMENT_LIMITS, AttachmentService } from "./attachment-service.js";
import { getOrchestratorSettings, saveOrchestratorSettings } from "./orchestrator-settings.js";
import { MAX_USER_AVATAR_BYTES, USER_AVATAR_SIZE_ERROR } from "../domain/user-avatar.js";
import { getUserAvatar, resetUserAvatar, saveUserAvatar, userAvatarImage } from "./user-avatar.js";
import { getOrchestratorAvatar, resetOrchestratorAvatar, saveOrchestratorAvatar, orchestratorAvatarImage } from "./orchestrator-avatar.js";
import { TaskTitleService, type TaskTitleGenerator } from "./task-title-service.js";
import { TerminalService } from "./terminal-service.js";
import { registerMessageFileRoutes } from "./message-file-routes.js";

const publicRoot = join(process.cwd(), "dist/public");
const legacyScriptRecovery = `void async function(){try{for(const key of await caches.keys())if(key.startsWith("qahwa-tasks-"))await caches.delete(key);const registration=await navigator.serviceWorker?.getRegistration();await registration?.update()}finally{const url=new URL("/",location.origin);url.searchParams.set("recovered",Date.now().toString());location.replace(url)}}();`;

function currentStylesheetPath(): string | undefined {
  try {
    const html = readFileSync(join(publicRoot, "index.html"), "utf8");
    const href = html.match(/<link\b[^>]*\bhref="(\/assets\/[A-Za-z0-9_.-]+\.css)"[^>]*>/i)?.[1];
    if (!href) return undefined;
    const path = join(publicRoot, href);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export interface AppContext {
  database: AppDatabase;
  auth: AuthService;
  tasks: TaskService;
  agents: AgentService;
  attachments: AttachmentService;
  titles: TaskTitleService;
  voice: VoiceService;
  terminals: TerminalService;
}

function booleanQuery(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

export async function buildApp(config: Config, database = new AppDatabase(config), options: { generateTitle?: TaskTitleGenerator; voice?: VoiceService } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 512 * 1024 });
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  await app.register(websocket);
  const auth = new AuthService(database, config.sessionDays);
  const tasks = new TaskService(database);
  const attachments = new AttachmentService(database);
  const push = new AppPushService(database, config);
  const agents = new AgentService(database, tasks, attachments, new TaskIdleNotifier(database, push));
  const titles = new TaskTitleService(database, tasks, options.generateTitle ?? agents.taskTitles.generate);
  app.addHook("onReady", async () => { titles.start(); });
  const pairing = new PairingService(database, auth, config.publicBaseUrl);
  const voice = options.voice ?? new VoiceService({ workDir: join(database.dataDir, "voice-tmp") });
  const terminals = new TerminalService(database, tasks);
  const context: AppContext = { database, auth, tasks, agents, attachments, titles, voice, terminals };
  pairing.register(app);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    const artifactResponse = /\/api\/(?:tasks\/[^/]+\/(?:outputs\/[^/]+\/artifacts\/\d+|files\/[^/?]+)|orchestrator\/files\/[^/?]+)/.test(request.url);
    reply.header("x-frame-options", artifactResponse ? "SAMEORIGIN" : "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", artifactResponse ? "camera=(), microphone=(), geolocation=()" : "camera=(), microphone=(self), geolocation=()");
    reply.header("content-security-policy", artifactResponse
      ? "default-src 'none'; frame-ancestors 'self'; sandbox"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https: http:; media-src 'self' blob: https: http:; frame-src 'self' blob: https: http:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (config.publicBaseUrl.startsWith("https://")) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (request.url.startsWith("/api/") || pathname === "/sw.js" || pathname === "/boot.js" || pathname === "/manifest.webmanifest") {
      reply.header("cache-control", "no-store");
    } else if (pathname.startsWith("/assets/") && reply.statusCode < 400 && !reply.getHeader("cache-control")) {
      reply.header("cache-control", "public, max-age=31536000, immutable");
    } else if (reply.getHeader("content-type")?.toString().startsWith("text/html")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.get("/health", async () => ({ status: "ok", service: "qahwa-tasks", time: new Date().toISOString() }));

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    auth.requireSession(request);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) validateOrigin(request, config.publicBaseUrl);
  });

  registerMessageFileRoutes(app, agents.files, tasks);

  app.get("/api/notifications/push", async request => push.settings(auth.requireSession(request).deviceId));
  app.put<{ Body: unknown }>("/api/notifications/push", async request => {
    push.subscribe(auth.requireSession(request).deviceId, request.body);
    return { subscribed: true };
  });
  app.delete("/api/notifications/push", async request => {
    push.unsubscribe(auth.requireSession(request).deviceId);
    return { subscribed: false };
  });

  app.post<{ Body: { category?: unknown; message?: unknown; path?: unknown } }>("/api/client-diagnostics", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const text = (value: unknown, maximum: number) => typeof value === "string" ? value.slice(0, maximum) : "";
    request.log.warn({
      clientDiagnostic: {
        category: text(request.body?.category, 80),
        message: text(request.body?.message, 4000),
        path: text(request.body?.path, 200),
      },
    }, "client bootstrap diagnostic");
    return reply.code(204).send();
  });

  app.get("/api/settings/orchestrator", async () => ({ settings: getOrchestratorSettings(database) }));
  app.get("/api/chat-models", async () => ({ models: await agents.models.list() }));
  app.put<{ Params: { id: string }; Body: unknown }>("/api/tasks/:id/model", async request => ({
    workspace: await agents.saveChatModel("task", request.params.id, request.body),
  }));
  app.put<{ Body: unknown }>("/api/orchestrator/model", async request => ({
    workspace: await agents.saveChatModel("orchestrator", "main", request.body),
  }));
  app.get("/api/settings/codex-usage", async () => ({ usage: await agents.usage.read() }));
  app.put<{ Body: unknown }>("/api/settings/orchestrator", async (request) => ({
    settings: saveOrchestratorSettings(database, request.body),
  }));

  app.get("/api/settings/avatar", async () => ({ avatar: getUserAvatar(database) }));
  app.put<{ Body: Buffer }>("/api/settings/avatar", {
    bodyLimit: MAX_USER_AVATAR_BYTES,
    errorHandler(error, _request, reply) {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.code(413).send({ error: "user_avatar_too_large", message: USER_AVATAR_SIZE_ERROR });
      }
      throw error;
    },
  }, async (request) => ({ avatar: saveUserAvatar(database,
    Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
    String(request.headers["content-type"] ?? "").split(";", 1)[0] ?? "",
  ) }));
  app.get("/api/settings/avatar/image", async (_request, reply) => {
    const image = userAvatarImage(database);
    return reply.type(image.mimeType).send(image.bytes);
  });
  app.delete("/api/settings/avatar", async () => ({ avatar: resetUserAvatar(database) }));

  app.get("/api/settings/orchestrator/avatar", async () => ({ avatar: getOrchestratorAvatar(database) }));
  app.put<{ Body: Buffer }>("/api/settings/orchestrator/avatar", {
    bodyLimit: MAX_USER_AVATAR_BYTES,
    errorHandler(error, _request, reply) {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.code(413).send({ error: "orchestrator_avatar_too_large", message: USER_AVATAR_SIZE_ERROR });
      }
      throw error;
    },
  }, async (request) => ({ avatar: saveOrchestratorAvatar(database,
    Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
    String(request.headers["content-type"] ?? "").split(";", 1)[0] ?? "",
  ) }));
  app.get("/api/settings/orchestrator/avatar/image", async (_request, reply) => {
    const image = orchestratorAvatarImage(database);
    return reply.type(image.mimeType).send(image.bytes);
  });
  app.delete("/api/settings/orchestrator/avatar", async () => ({ avatar: resetOrchestratorAvatar(database) }));

  app.get("/api/devices", async () => ({ devices: database.db.prepare(`
    SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt
    FROM paired_devices ORDER BY created_at DESC
  `).all() }));
  app.post<{ Params: { id: string } }>("/api/devices/:id/revoke", async (request) => {
    database.db.transaction(() => {
      database.db.prepare("UPDATE paired_devices SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), request.params.id);
      database.db.prepare("DELETE FROM sessions WHERE device_id = ?").run(request.params.id);
      push.unsubscribe(request.params.id);
    })();
    return { revoked: true };
  });
  registerProjectRoutes(app, context);
  registerTaskRoutes(app, context);
  registerAgentRoutes(app, context);
  registerCommentRoutes(app, context);
  registerTerminalRoutes(app, context);

  if (existsSync(publicRoot)) {
    // Resolve files at request time. Exact routes snapshot the directory during
    // startup, so assets restored by an in-place release remain invisible until
    // another restart and stale installed clients cannot recover.
    await app.register(fastifyStatic, { root: publicRoot, wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      if (pathname.startsWith("/assets/")) {
        if (pathname.endsWith(".js")) {
          return reply.header("cache-control", "no-store").type("application/javascript").send(legacyScriptRecovery);
        }
        if (pathname.endsWith(".css")) {
          const stylesheet = currentStylesheetPath();
          if (stylesheet) return reply.header("cache-control", "no-store").type("text/css").send(createReadStream(stylesheet));
          return reply.header("cache-control", "no-store").code(503).send({ error: "stylesheet_unavailable" });
        }
        return reply.header("cache-control", "no-store").code(404).send({ error: "asset_not_found" });
      }
      return reply.type("text/html").sendFile("index.html");
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if ((error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.code(400).send({ error: "invalid_json", message: "Invalid JSON body" });
    }
    if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: "body_too_large", message: "Upload is too large" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  app.addHook("onClose", async () => {
    await terminals.close();
    await voice.close();
    await titles.close();
    agents.close();
    attachments.close();
    database.close();
  });
  return app;
}

function registerTerminalRoutes(app: FastifyInstance, { auth, terminals }: AppContext): void {
  app.post<{ Body: { projectId?: unknown; creationKey?: unknown } }>("/api/terminals", async (request, reply) => {
    const deviceId = auth.requireSession(request).deviceId;
    return reply.code(201).send(await terminals.create(request.body?.projectId, request.body?.creationKey, deviceId));
  });
  app.get<{ Params: { id: string }; Querystring: { generation?: string; cursor?: string; wait?: string } }>("/api/tasks/:id/terminal", async request => {
    const result = await terminals.read(request.params.id, request.query.generation,
      request.query.cursor === undefined ? undefined : Number(request.query.cursor), request.query.wait === "1");
    // A revocation while a long poll is waiting also blocks its response.
    auth.requireSession(request);
    return { terminal: result };
  });
  app.post<{ Params: { id: string }; Body: { generation?: unknown; inputId?: unknown; data?: unknown; binary?: unknown; message?: unknown } }>("/api/tasks/:id/terminal/input", async request => {
    terminals.input(request.params.id, request.body ?? {});
    return { accepted: true };
  });
  app.put<{ Params: { id: string }; Body: { generation?: unknown; cols?: unknown; rows?: unknown } }>("/api/tasks/:id/terminal/size", async request => {
    await terminals.resize(request.params.id, request.body ?? {});
    return { resized: true };
  });
  app.post<{ Params: { id: string }; Body: { generation?: unknown } }>("/api/tasks/:id/terminal/start", async request => {
    await terminals.start(request.params.id, request.body?.generation);
    return { terminal: await terminals.read(request.params.id) };
  });
  for (const action of ["stop", "close", "restore"] as const) {
    app.post<{ Params: { id: string }; Body: { generation?: unknown } }>(`/api/tasks/:id/terminal/${action}`, async request => {
      await terminals.lifecycle(request.params.id, request.body?.generation, action);
      const terminal = await terminals.read(request.params.id);
      // Paired-device revocation while a shutdown waits also blocks its response.
      auth.requireSession(request);
      return { terminal };
    });
  }
}

function validateOrigin(request: FastifyRequest, publicBaseUrl: string): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const allowed = new Set([publicBaseUrl, `http://127.0.0.1:${new URL(publicBaseUrl).port || "3022"}`, "http://localhost:5173"]);
  if (!allowed.has(origin)) throw new DomainError("Origin not allowed", "invalid_origin", 403);
}

function registerProjectRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Querystring: { includeArchived?: string } }>("/api/projects", async (request) => ({
    projects: context.tasks.listProjects(booleanQuery(request.query.includeArchived)),
  }));
  app.post<{ Body: { name: string; prefix?: string; rootDirectory: string } }>("/api/projects", async (request, reply) => {
    const project = context.tasks.createProject(request.body, "user");
    return reply.code(201).send({ project });
  });
  app.patch<{ Params: { id: string }; Body: { name?: string; prefix?: string; rootDirectory?: string } }>(
    "/api/projects/:id", async (request) => ({ project: context.tasks.updateProject(request.params.id, request.body, "user") }),
  );
  app.put<{ Params: { id: string }; Body: Buffer }>("/api/projects/:id/logo", {
    bodyLimit: MAX_PROJECT_LOGO_BYTES,
    errorHandler(error, _request, reply) {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.code(413).send({ error: "project_logo_too_large", message: PROJECT_LOGO_SIZE_ERROR });
      }
      throw error;
    },
  }, async (request) => ({
    project: context.tasks.uploadProjectLogo(
      request.params.id,
      Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      String(request.headers["content-type"] ?? "").split(";", 1)[0] ?? "",
      "user",
    ),
  }));
  app.get<{ Params: { id: string } }>("/api/projects/:id/logo", async (request, reply) => {
    const logo = context.tasks.projectLogoFile(request.params.id);
    if (!existsSync(logo.path)) throw new DomainError("Project logo not found", "project_logo_not_found", 404);
    return reply.header("cache-control", "private, max-age=31536000, immutable").type(logo.mimeType).send(createReadStream(logo.path));
  });
  app.delete<{ Params: { id: string } }>("/api/projects/:id/logo", async (request) => ({
    project: context.tasks.removeProjectLogo(request.params.id, "user"),
  }));
  app.post<{ Params: { id: string }; Body: { archived: boolean } }>("/api/projects/:id/archive", async (request) => ({
    project: context.tasks.archiveProject(request.params.id, Boolean(request.body.archived), "user"),
  }));
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    context.tasks.deleteProject(request.params.id, "user");
    return reply.code(204).send();
  });
}

function registerTaskRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Body: { taskIds?: unknown } }>("/api/task-titles/backfill", async request => ({
    enrolled: context.titles.requestBackfill(request.body?.taskIds),
  }));
  app.get<{ Querystring: { tab?: "all" | "active" | "backlog" | "todo" | "open" | "closed"; projectId?: string; order?: "conversation" } }>(
    "/api/tasks", async (request) => ({ tasks: context.tasks.listTasks(request.query) }),
  );
  const creation = new TaskCreationService(context.database, context.tasks, context.attachments);
  app.post<{ Params: { id: string }; Body: { filename?: unknown; mediaType?: unknown; size?: unknown } }>("/api/task-drafts/:id/attachments", async (request, reply) => {
    const deviceId = context.auth.requireSession(request).deviceId;
    return reply.code(201).send({ attachment: creation.initiate(request.params.id, deviceId, request.body) });
  });
  app.delete<{ Params: { id: string } }>("/api/task-drafts/:id", async (request, reply) => {
    creation.cancel(request.params.id, context.auth.requireSession(request).deviceId);
    return reply.code(204).send();
  });
  app.post<{ Body: TaskCreationInput }>("/api/tasks", async (request, reply) => {
    const task = creation.create(request.body, context.auth.requireSession(request).deviceId);
    return reply.code(201).send({ task });
  });
  app.get<{ Params: { id: string }; Querystring: { includeResolved?: string } }>("/api/tasks/:id", async (request) => ({
    task: context.tasks.getTask(request.params.id, request.query.includeResolved !== "false"),
  }));
  app.patch<{ Params: { id: string }; Body: { title?: string; description?: RichTextDocument; expectedVersion: number } }>(
    "/api/tasks/:id", async (request) => ({ task: context.tasks.updateTask(request.params.id, request.body, "user") }),
  );
  app.put<{ Params: { id: string }; Body: { enabled?: unknown } }>("/api/tasks/:id/idle-notifications", async (request) => ({
    task: context.tasks.setIdleNotifications(request.params.id, request.body?.enabled),
  }));
  app.put<{ Params: { id: string }; Body: { pinned?: unknown } }>("/api/tasks/:id/pin", async (request) => ({
    task: context.tasks.setPinned(request.params.id, request.body?.pinned),
  }));
  app.post<{ Params: { id: string }; Body: { to: TaskStatus; outcome?: "completed" | "cancelled"; onlyIfUnstarted?: boolean } }>(
    "/api/tasks/:id/transition", async (request) => ({ task: context.tasks.transition(request.params.id, request.body, "user") }),
  );
  app.post<{ Params: { id: string }; Body: { expectedVersion?: unknown } }>(
    "/api/tasks/:id/restore", async (request) => ({ task: context.tasks.restoreCodex(request.params.id, request.body?.expectedVersion) }),
  );
  app.post<{ Params: { id: string }; Body: { beforeId?: string | null; afterId?: string | null } }>(
    "/api/tasks/:id/reorder", async (request) => ({ task: context.tasks.reorder(request.params.id, request.body, "user") }),
  );
  app.post<{ Params: { id: string }; Body: { relatedTaskId: string } }>(
    "/api/tasks/:id/related", async (request) => ({
      task: context.tasks.addRelatedTask(request.params.id, request.body.relatedTaskId, "user"),
    }),
  );
  app.delete<{ Params: { id: string; relatedId: string } }>(
    "/api/tasks/:id/related/:relatedId", async (request) => ({
      task: context.tasks.removeRelatedTask(request.params.id, request.params.relatedId, "user"),
    }),
  );
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    context.tasks.deleteBacklogTask(request.params.id, "user");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id/activity", async (request) => ({
    activity: context.tasks.activityForTask(request.params.id),
  }));
  app.get<{
    Params: { id: string; outputId: string; index: string };
    Querystring: { download?: string };
  }>("/api/tasks/:id/outputs/:outputId/artifacts/:index", async (request, reply) => {
    const index = Number(request.params.index);
    if (!Number.isSafeInteger(index) || index < 0) throw new DomainError("Artifact not found", "artifact_not_found", 404);
    const artifact = context.tasks.artifactFile(request.params.id, request.params.outputId, index);
    const disposition = booleanQuery(request.query.download) ? "attachment" : "inline";
    const safeFilename = artifact.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encodedFilename = encodeURIComponent(artifact.filename);
    reply.header("accept-ranges", "bytes");
    reply.header("content-disposition", `${disposition}; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    reply.type(artifact.mediaType);
    const range = request.headers.range;
    if (!range) return reply.header("content-length", artifact.size).send(createReadStream(artifact.path));
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      return reply.code(416).header("content-range", `bytes */${artifact.size}`).send();
    }
    let start = match[1] ? Number(match[1]) : Math.max(0, artifact.size - Number(match[2]));
    let end = match[2] && match[1] ? Number(match[2]) : artifact.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= artifact.size) {
      return reply.code(416).header("content-range", `bytes */${artifact.size}`).send();
    }
    end = Math.min(end, artifact.size - 1);
    return reply.code(206)
      .header("content-range", `bytes ${start}-${end}/${artifact.size}`)
      .header("content-length", end - start + 1)
      .send(createReadStream(artifact.path, { start, end }));
  });
  app.post<{ Params: { id: string; outputId: string } }>(
    "/api/tasks/:id/outputs/:outputId/approve-commit", async (request) => ({
      task: context.tasks.approveOutputCommit(request.params.id, request.params.outputId, "user"),
    }),
  );
  app.get("/api/export", async (_request, reply) => reply
    .header("content-disposition", `attachment; filename="qahwa-tasks-${new Date().toISOString().slice(0, 10)}.json"`)
    .send(context.tasks.exportData()));
}

function registerAgentRoutes(app: FastifyInstance, context: AppContext): void {
  const reads = new MessageReadService(context.database);
  app.get<{ Params: { id: string } }>("/api/tasks/:id/unread", async (request) => ({
    readState: reads.unread("task", context.tasks.getTask(request.params.id).id),
  }));
  app.post<{ Params: { id: string }; Body: { messageIds?: unknown } }>("/api/tasks/:id/read", async (request) => ({
    readState: reads.markRead("task", context.tasks.getTask(request.params.id).id, request.body?.messageIds),
  }));
  app.get("/api/orchestrator/unread", async () => ({
    readState: reads.unread("orchestrator", "main"),
    sessionState: context.agents.sessionRunState("orchestrator", "main"),
  }));
  app.post<{ Body: { messageIds?: unknown } }>("/api/orchestrator/read", async (request) => ({
    readState: reads.markRead("orchestrator", "main", request.body?.messageIds),
  }));
  app.get("/api/capacity", async () => ({ capacity: context.agents.capacity() }));
  app.put<{ Params: { id: string }; Body: { mode?: unknown; expectedVersion?: unknown } }>("/api/tasks/:id/access", async request => ({
    workspace: context.agents.requestTaskAccess(request.params.id, request.body ?? {}),
  }));
  app.get<{ Params: { id: string }; Querystring: MessagePageQuery }>("/api/tasks/:id/messages", async request => ({
    page: context.agents.messagePage("task", request.params.id, request.query),
  }));
  app.get<{ Querystring: MessagePageQuery }>("/api/orchestrator/messages", async request => ({
    page: context.agents.messagePage("orchestrator", "main", request.query),
  }));
  app.get<{ Params: { id: string }; Querystring: WorkspaceCursor & { poll?: string } }>("/api/tasks/:id/workspace", async (request) => {
    const workspace = context.agents.workspace("task", request.params.id);
    return request.query.poll === "1" ? workspacePoll(workspace, request.query) : { workspace };
  });
  app.put<{ Params: { id: string }; Body: import("./task-schedules.js").ScheduleInput }>("/api/tasks/:id/schedule", async request => ({
    workspace: context.agents.saveSchedule(request.params.id, request.body ?? {}),
  }));
  app.post<{ Params: { id: string }; Body: { expectedVersion?: unknown } }>("/api/tasks/:id/schedule/cancel", async request => ({
    workspace: context.agents.cancelSchedule(request.params.id, request.body?.expectedVersion),
  }));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/trigger", async (request, reply) => {
    const workspace = await context.agents.triggerTask(request.params.id);
    return reply.code(202).send({ workspace });
  });
  app.put<{ Params: { id: string; messageId: string }; Body: import("./message-schedules.js").FollowupInput }>("/api/tasks/:id/messages/:messageId/schedule", async request => ({
    workspace: context.agents.saveFollowup(request.params.id, request.params.messageId, request.body ?? {}),
  }));
  app.post<{ Params: { id: string; messageId: string }; Body: { expectedVersion?: unknown } }>("/api/tasks/:id/messages/:messageId/schedule/cancel", async request => ({
    workspace: context.agents.cancelFollowup(request.params.id, request.params.messageId, request.body?.expectedVersion),
  }));
  app.post<{ Params: { id: string }; Body: { message?: string; attachmentIds?: string[]; designPageId?: unknown; selectedExcerpt?: unknown; timezone?: unknown } }>("/api/tasks/:id/messages", async (request, reply) => {
    const deviceId = context.auth.requireSession(request).deviceId;
    const workspace = await context.agents.send("task", request.params.id, request.body.message ?? "", false, "user", request.body.attachmentIds ?? [], deviceId, [], request.body.designPageId, request.body.selectedExcerpt, request.body.timezone);
    return reply.code(202).send({ workspace });
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/interrupt", async (request) => ({
    workspace: await context.agents.interrupt("task", request.params.id),
  }));
  app.patch<{ Params: { id: string; messageId: string }; Body: { message?: unknown; expectedVersion?: unknown } }>("/api/tasks/:id/messages/:messageId", async request => ({
    workspace: context.agents.editPendingMessage("task", request.params.id, request.params.messageId, request.body),
  }));
  app.post<{ Params: { id: string; messageId: string } }>("/api/tasks/:id/messages/:messageId/cancel", async request => ({
    workspace: context.agents.cancelPendingMessage("task", request.params.id, request.params.messageId),
  }));
  app.post<{ Params: { id: string; messageId: string } }>("/api/tasks/:id/messages/:messageId/run-now", async (request, reply) => {
    const workspace = await context.agents.runPendingMessageNow("task", request.params.id, request.params.messageId);
    return reply.code(202).send({ workspace });
  });
  app.post<{ Params: { id: string }; Body: { name?: unknown } }>("/api/tasks/:id/design/pages", async (request) => ({
    workspace: context.agents.createDesignPage(request.params.id, request.body?.name),
  }));
  app.post<{ Params: { id: string; pageId: string } }>("/api/tasks/:id/design/pages/:pageId/select", async (request) => ({
    workspace: context.agents.selectDesignPage(request.params.id, request.params.pageId),
  }));
  app.patch<{ Params: { id: string; pageId: string }; Body: { name?: unknown } }>("/api/tasks/:id/design/pages/:pageId", async (request) => ({
    workspace: context.agents.renameDesignPage(request.params.id, request.params.pageId, request.body?.name),
  }));
  app.get<{ Querystring: WorkspaceCursor & { poll?: string } }>("/api/orchestrator", async (request) => {
    const workspace = context.agents.workspace("orchestrator", "main");
    return { ...(request.query.poll === "1" ? workspacePoll(workspace, request.query) : { workspace }), capacity: context.agents.capacity() };
  });
  app.post<{ Body: { message?: string; attachmentIds?: string[]; selectedTaskIds?: unknown; selectedExcerpt?: unknown } }>("/api/orchestrator/messages", async (request, reply) => {
    const deviceId = context.auth.requireSession(request).deviceId;
    const workspace = await context.agents.send("orchestrator", "main", request.body.message ?? "", false, "user", request.body.attachmentIds ?? [], deviceId, request.body.selectedTaskIds, undefined, request.body.selectedExcerpt);
    return reply.code(202).send({ workspace });
  });
  app.post("/api/orchestrator/interrupt", async () => ({
    workspace: await context.agents.interrupt("orchestrator", "main"),
  }));
  app.patch<{ Params: { messageId: string }; Body: { message?: unknown; expectedVersion?: unknown } }>("/api/orchestrator/messages/:messageId", async request => ({
    workspace: context.agents.editPendingMessage("orchestrator", "main", request.params.messageId, request.body),
  }));
  app.post<{ Params: { messageId: string } }>("/api/orchestrator/messages/:messageId/cancel", async request => ({
    workspace: context.agents.cancelPendingMessage("orchestrator", "main", request.params.messageId),
  }));
  app.post<{ Params: { messageId: string } }>("/api/orchestrator/messages/:messageId/run-now", async (request, reply) => {
    const workspace = await context.agents.runPendingMessageNow("orchestrator", "main", request.params.messageId);
    return reply.code(202).send({ workspace });
  });
  app.post("/api/orchestrator/clean", async () => ({ workspace: await context.agents.cleanOrchestrator() }));
  app.get("/api/voice-transcriptions/availability", async () => ({ available: await context.voice.available() }));
  for (const mode of ["task", "orchestrator"] as const) {
    const base = mode === "task" ? "/api/tasks/:id" : "/api/orchestrator";
    app.post<{ Params: { id?: string; attachmentId: string } }>(`${base}/voice/:attachmentId/transcription`, async (request, reply) => {
      const ownerId = mode === "task" ? context.tasks.getTask(request.params.id!).id : "main";
      const deviceId = context.auth.requireSession(request).deviceId;
      const [attachment] = context.attachments.prepareForMessage(mode, ownerId, deviceId, [request.params.attachmentId]);
      return reply.code(202).send({ transcription: await context.voice.start(attachment!, deviceId, () => context.attachments.remove(attachment!.id, deviceId)) });
    });
  }
  app.get<{ Params: { id: string } }>("/api/voice-transcriptions/:id", async (request) => ({
    transcription: context.voice.get(request.params.id, context.auth.requireSession(request).deviceId),
  }));
  app.delete<{ Params: { id: string } }>("/api/voice-transcriptions/:id", async (request, reply) => {
    context.voice.cancel(request.params.id, context.auth.requireSession(request).deviceId);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { filename?: unknown; mediaType?: unknown; size?: unknown } }>("/api/tasks/:id/attachments", async (request, reply) => {
    const task = context.tasks.getTask(request.params.id);
    const deviceId = context.auth.requireSession(request).deviceId;
    return reply.code(201).send({ attachment: context.attachments.initiate("task", task.id, deviceId, request.body) });
  });
  app.post<{ Body: { filename?: unknown; mediaType?: unknown; size?: unknown } }>("/api/orchestrator/attachments", async (request, reply) => {
    const deviceId = context.auth.requireSession(request).deviceId;
    return reply.code(201).send({ attachment: context.attachments.initiate("orchestrator", "main", deviceId, request.body) });
  });
  app.put<{ Params: { id: string; chunk: string }; Body: Buffer }>("/api/attachments/:id/chunks/:chunk", async (request) => {
    const deviceId = context.auth.requireSession(request).deviceId;
    return context.attachments.appendChunk(request.params.id, deviceId, Number(request.params.chunk), Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0));
  });
  app.post<{ Params: { id: string } }>("/api/attachments/:id/complete", async (request) => {
    const deviceId = context.auth.requireSession(request).deviceId;
    return { attachment: context.attachments.complete(request.params.id, deviceId) };
  });
  app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const deviceId = context.auth.requireSession(request).deviceId;
    context.attachments.remove(request.params.id, deviceId);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string; attachmentId: string }; Querystring: { offset?: string } }>("/api/tasks/:id/attachments/:attachmentId", async (request, reply) => {
    const task = context.tasks.getTask(request.params.id);
    const result = context.attachments.resolveDownload("task", task.id, request.params.attachmentId);
    return sendAttachment(reply, result.path, result.attachment.filename, result.attachment.mediaType, result.attachment.size, request.query.offset);
  });
  app.get<{ Params: { attachmentId: string }; Querystring: { offset?: string } }>("/api/orchestrator/attachments/:attachmentId", async (request, reply) => {
    const result = context.attachments.resolveDownload("orchestrator", "main", request.params.attachmentId);
    return sendAttachment(reply, result.path, result.attachment.filename, result.attachment.mediaType, result.attachment.size, request.query.offset);
  });
  app.post<{ Params: { requestId: string }; Body: { approved?: boolean; answers?: Record<string, string> } }>(
    "/api/session-requests/:requestId/respond", async (request) => {
      await context.agents.resolveRequest(request.params.requestId, request.body);
      return { resolved: true };
    },
  );
}

function sendAttachment(reply: import("fastify").FastifyReply, path: string, filename: string, mediaType: string, size: number, rawOffset?: string) {
  const safeFilename = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  assertDownloadOffset(offset, size);
  const length = Math.min(ATTACHMENT_LIMITS.chunkBytes, Math.max(0, size - offset));
  const response = reply
    .header("content-disposition", `inline; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .header("content-length", length)
    .header("accept-ranges", "bytes")
    .type(mediaType);
  if (size === 0) return response.send(Buffer.alloc(0));
  return response.code(length === size ? 200 : 206)
    .header("content-range", `bytes ${offset}-${offset + length - 1}/${size}`)
    .send(createReadStream(path, { start: offset, end: offset + length - 1 }));
}

function assertDownloadOffset(offset: number, size: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || (size > 0 && offset >= size) || (size === 0 && offset !== 0)) {
    throw new DomainError("Attachment range is invalid", "invalid_attachment_range", 416);
  }
}

function registerCommentRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{
    Params: { id: string };
    Body: { body: RichTextDocument; parentId?: string; requiresResponse?: boolean; metadata?: Record<string, unknown> };
  }>("/api/tasks/:id/comments", async (request, reply) => {
    const comment = context.tasks.addComment(request.params.id, request.body, "user");
    return reply.code(201).send({ comment });
  });
  app.post<{ Params: { id: string }; Body: { resolved: boolean; reply?: RichTextDocument } }>(
    "/api/comments/:id/resolution", async (request) => ({
      comment: context.tasks.resolveComment(request.params.id, Boolean(request.body.resolved), "user", request.body.reply),
    }),
  );
}
