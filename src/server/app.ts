import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import type { RichTextDocument, TaskStatus } from "../domain/types.js";
import { AuthService } from "./auth.js";
import type { Config } from "./config.js";
import { AppDatabase } from "./database.js";
import { TaskService, type CreateTaskInput } from "./task-service.js";

const publicRoot = join(process.cwd(), "dist/public");
const legacyScriptRecovery = `void async function(){try{for(const key of await caches.keys())if(key.startsWith("qahwa-tasks-"))await caches.delete(key);const registration=await navigator.serviceWorker?.getRegistration();await registration?.update()}finally{const url=new URL("/",location.origin);url.searchParams.set("recovered",Date.now().toString());location.replace(url)}}();`;

export interface AppContext {
  database: AppDatabase;
  auth: AuthService;
  tasks: TaskService;
}

function booleanQuery(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

export async function buildApp(config: Config, database = new AppDatabase(config)): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 512 * 1024 });
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const auth = new AuthService(database, config.sessionDays, config.publicBaseUrl.startsWith("https://"));
  const tasks = new TaskService(database);
  const context: AppContext = { database, auth, tasks };

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    const artifactResponse = /\/api\/tasks\/[^/]+\/outputs\/[^/]+\/artifacts\/\d+/.test(request.url);
    reply.header("x-frame-options", artifactResponse ? "SAMEORIGIN" : "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("content-security-policy", artifactResponse
      ? "default-src 'none'; frame-ancestors 'self'; sandbox"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; media-src 'self' https: http:; frame-src 'self' https: http:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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

  app.get("/health", async () => ({ status: "ok", service: "qahwa-tasks", configured: auth.isConfigured(), time: new Date().toISOString() }));
  app.get("/api/auth/state", async (request) => ({ authenticated: auth.authenticated(request), configured: auth.isConfigured() }));
  app.post<{ Body: { password: string } }>("/api/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    await auth.login(request.body.password ?? "", request, reply);
    return { authenticated: true };
  });
  app.post<{ Body: { password: string; token: string } }>("/api/auth/setup", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    await auth.setup(request.body.password ?? "", request.body.token ?? "", request, reply);
    return { authenticated: true, configured: true };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url.startsWith("/api/auth/login") || request.url.startsWith("/api/auth/setup") || request.url.startsWith("/api/auth/state")) return;
    auth.requireSession(request, reply);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) validateOrigin(request, config.publicBaseUrl);
  });

  app.post<{ Body: { category?: unknown; message?: unknown; path?: unknown } }>("/api/client-diagnostics", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const text = (value: unknown, maximum: number) => typeof value === "string" ? value.slice(0, maximum) : "";
    request.log.warn({
      clientDiagnostic: {
        category: text(request.body?.category, 80),
        message: text(request.body?.message, 500),
        path: text(request.body?.path, 200),
      },
    }, "client bootstrap diagnostic");
    return reply.code(204).send();
  });

  registerAuthRoutes(app, context);
  registerProjectRoutes(app, context);
  registerTaskRoutes(app, context);
  registerCommentRoutes(app, context);

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
          return reply.header("cache-control", "no-store").type("text/css").send("/* retired release stylesheet */");
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

  app.addHook("onClose", async () => database.close());
  return app;
}

function validateOrigin(request: FastifyRequest, publicBaseUrl: string): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const allowed = new Set([publicBaseUrl, `http://127.0.0.1:${new URL(publicBaseUrl).port || "3022"}`, "http://localhost:5173"]);
  if (!allowed.has(origin)) throw new DomainError("Origin not allowed", "invalid_origin", 403);
}

function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/api/auth/logout", async (request, reply) => {
    context.auth.logout(request, reply);
    return { authenticated: false };
  });
  app.post("/api/auth/revoke-all", async (request, reply) => {
    context.auth.revokeAll();
    reply.clearCookie("qahwa_tasks_session", { path: "/" });
    return { revoked: true };
  });
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
  app.put<{ Params: { id: string }; Body: Buffer }>("/api/projects/:id/logo", async (request) => ({
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
  app.get<{ Querystring: { tab?: "backlog" | "todo" | "open" | "closed"; projectId?: string } }>(
    "/api/tasks", async (request) => ({ tasks: context.tasks.listTasks(request.query) }),
  );
  app.post<{ Body: CreateTaskInput }>("/api/tasks", async (request, reply) => {
    const task = context.tasks.createTask(request.body, "user");
    return reply.code(201).send({ task });
  });
  app.get<{ Params: { id: string }; Querystring: { includeResolved?: string } }>("/api/tasks/:id", async (request) => ({
    task: context.tasks.getTask(request.params.id, request.query.includeResolved !== "false"),
  }));
  app.patch<{ Params: { id: string }; Body: { title?: string; description?: RichTextDocument; expectedVersion: number } }>(
    "/api/tasks/:id", async (request) => ({ task: context.tasks.updateTask(request.params.id, request.body, "user") }),
  );
  app.post<{ Params: { id: string }; Body: { to: TaskStatus; outcome?: "completed" | "cancelled" } }>(
    "/api/tasks/:id/transition", async (request) => ({ task: context.tasks.transition(request.params.id, request.body, "user") }),
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

function registerCommentRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{
    Params: { id: string };
    Body: { body: RichTextDocument; parentId?: string; requiresResponse?: boolean };
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
