import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import { VoiceService } from "../src/server/voice-service.js";
import { AuthService } from "../src/server/auth.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";
import { voiceWav } from "./helpers/voice.js";

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "voice-api-test-"));
  const root = join(dataDir, "project"); mkdirSync(root);
  const config = { host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir, backupDir: join(dataDir, "backups"), sessionDays: 365 };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365);
  const stamp = new Date().toISOString();
  for (const id of ["device", "other"]) database.db.prepare("INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at) VALUES (?, ?, '', ?, ?)").run(id, id, stamp, stamp);
  const headers = { authorization: `Bearer ${auth.createSession("test", "local", "device").token}`, origin: config.publicBaseUrl };
  const other = { ...headers, authorization: `Bearer ${auth.createSession("test", "local", "other").token}` };
  const tasks = new TaskService(database);
  const project = tasks.createProject({ name: "Voice", prefix: "VOC", rootDirectory: root }, "user");
  const task = tasks.createTask({ projectId: project.id, title: "Voice message", status: "todo" }, "user");
  const model = join(dataDir, "model.bin"); writeFileSync(model, "fake model");
  const voice = new VoiceService({ cli: process.execPath, model, run: async (_command, args) => {
    if (args.includes("-otxt")) await writeFile(`${args[args.indexOf("-of") + 1]}.txt`, "Editable voice transcript");
    else await writeFile(args.at(-1)!, voiceWav());
  } });
  const app = await buildApp(config, database, { voice });
  return { app, headers, other, task, database };
}

test("both chats transcribe only owned complete uploads without sending a message", async () => {
  const { app, headers, other, task, database } = await fixture();
  try {
    assert.equal((await app.inject({ url: "/api/voice-transcriptions/availability" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/voice-transcriptions/availability", headers })).json().available, true);
    for (const base of [`/api/tasks/${task.id}`, "/api/orchestrator"]) {
      const create = await app.inject({ method: "POST", url: `${base}/attachments`, headers, payload: { filename: "voice.webm", mediaType: "audio/webm", size: 3 } });
      assert.equal(create.statusCode, 201, create.body);
      const id = create.json().attachment.id;
      const start = `${base}/voice/${id}/transcription`;
      assert.equal((await app.inject({ method: "POST", url: start, headers })).statusCode, 409);
      await app.inject({ method: "PUT", url: `/api/attachments/${id}/chunks/0`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("ogg") });
      await app.inject({ method: "POST", url: `/api/attachments/${id}/complete`, headers });
      assert.equal((await app.inject({ method: "POST", url: start, headers: other })).statusCode, 403);
      const wrongBase = base.startsWith("/api/tasks/") ? "/api/orchestrator" : `/api/tasks/${task.id}`;
      assert.equal((await app.inject({ method: "POST", url: `${wrongBase}/voice/${id}/transcription`, headers })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: start, headers: { ...headers, origin: "https://evil.example" } })).statusCode, 403);
      const accepted = await app.inject({ method: "POST", url: start, headers });
      assert.equal(accepted.statusCode, 202, accepted.body);
      const jobId = accepted.json().transcription.id;
      assert.equal((await app.inject({ url: `/api/voice-transcriptions/${jobId}`, headers: other })).statusCode, 404);
      let result;
      for (let i = 0; i < 100; i++) {
        result = (await app.inject({ url: `/api/voice-transcriptions/${jobId}`, headers })).json().transcription;
        if (result.status !== "processing") break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(result.status, "complete"); assert.equal(result.text, "Editable voice transcript");
      assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM chat_messages").get() as { count: number }).count, 0);
      assert.equal((await app.inject({ method: "DELETE", url: `/api/voice-transcriptions/${jobId}`, headers })).statusCode, 204);
      assert.equal((await app.inject({ url: `/api/voice-transcriptions/${jobId}`, headers })).statusCode, 404);
    }
  } finally { await app.close(); }
});

test("microphone permissions are same-origin and CSP permits local recording previews", async () => {
  const { app } = await fixture();
  try {
    const health = await app.inject({ url: "/health" });
    assert.match(String(health.headers["permissions-policy"]), /microphone=\(self\)/);
    assert.match(String(health.headers["content-security-policy"]), /media-src 'self' blob:/);
    const artifact = await app.inject({ url: "/api/tasks/none/outputs/none/artifacts/0" });
    assert.match(String(artifact.headers["permissions-policy"]), /microphone=\(\)/);
  } finally { await app.close(); }
});
