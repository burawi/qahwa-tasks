import { closeSync, createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MessageFiles } from "./message-files.js";
import type { TaskService } from "./task-service.js";

export function registerMessageFileRoutes(app: FastifyInstance, files: MessageFiles, tasks: TaskService): void {
  type Request = FastifyRequest<{ Params: { id?: string; fileId: string }; Querystring: { download?: string } }>;
  const serve = (request: Request, reply: FastifyReply) => {
    const ownerType = request.params.id ? "task" : "orchestrator";
    const ownerId = request.params.id ? tasks.getTask(request.params.id).id : "main";
    const file = files.open(ownerType, ownerId, request.params.fileId);
    let handedOff = false;
    try {
      const filename = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const disposition = ["1", "true"].includes(request.query.download ?? "") ? "attachment" : "inline";
      reply.header("content-disposition", `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      reply.header("accept-ranges", "bytes").type(file.mediaType);
      let start = 0;
      let end = file.size - 1;
      const range = request.headers.range;
      // Empty files have a valid complete response, including to the client's
      // initial range request. A 416 would make their Download control fail.
      if (range && file.size > 0) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return reply.code(416).header("content-range", `bytes */${file.size}`).send();
        start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
        end = match[1] && match[2] ? Number(match[2]) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= file.size) {
          return reply.code(416).header("content-range", `bytes */${file.size}`).send();
        }
        end = Math.min(end, file.size - 1);
        reply.code(206).header("content-range", `bytes ${start}-${end}/${file.size}`);
      }
      reply.header("content-length", file.size === 0 ? 0 : end - start + 1);
      const stream = createReadStream("", { fd: file.fd, autoClose: true, ...(file.size ? { start, end } : {}) });
      handedOff = true;
      return reply.send(stream);
    } finally {
      if (!handedOff) closeSync(file.fd);
    }
  };
  app.get("/api/tasks/:id/files/:fileId", serve);
  app.get("/api/orchestrator/files/:fileId", serve);
}
