import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import nacl from "tweetnacl";
import WebSocket from "ws";
import { buildApp } from "../src/server/app.js";
import { AuthService } from "../src/server/auth.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import type { WorkspacePoll } from "../src/domain/types.js";
import { PairingService } from "../src/server/pairing.js";
import { projectLogoPng } from "./helpers/project-logo.js";

const b64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64"));

async function message(socket: { once: (event: string, listener: (value: unknown) => void) => unknown }): Promise<Record<string, unknown>> {
  const [raw] = await once(socket as never, "message") as [Buffer];
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

test("Qahwa Design-style pairing keeps credentials inside an encrypted persistent RPC channel", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-pairing-"));
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir,
    backupDir: join(dataDir, "backups"), sessionDays: 365,
  };
  const database = new AppDatabase(config);
  const auth = new AuthService(database, 365);
  const link = new PairingService(database, auth, config.publicBaseUrl).createLink();
  const app = await buildApp(config, database);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const socketUrl = `ws://127.0.0.1:${address.port}/rpc`;
    const uri = new URL(link.uri.replace(/^qahwa:\/\//, "https://qahwa.invalid/"));
    const grant = uri.searchParams.get("grant")!;
    const serverPublicKey = uri.searchParams.get("serverKey")!;
    const client = nacl.box.keyPair();
    const deviceId = "test-browser";

    const pairSocket = await openSocket(socketUrl);
    const pairedMessage = message(pairSocket);
    pairSocket.send(JSON.stringify({ type: "pair", grant, deviceId, deviceName: "Test browser", publicKey: b64(client.publicKey) }));
    assert.equal((await pairedMessage).type, "paired");
    pairSocket.close();
    await once(pairSocket, "close");

    const authSocket = await openSocket(socketUrl);
    const challengeMessage = message(authSocket);
    authSocket.send(JSON.stringify({ type: "hello", deviceId }));
    const challenge = await challengeMessage;
    assert.equal(challenge.type, "challenge");
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const proof = nacl.box(Buffer.from(String(challenge.challenge)), nonce, bytes(serverPublicKey), client.secretKey);
    const readyMessage = message(authSocket);
    authSocket.send(JSON.stringify({ type: "auth", nonce: b64(nonce), proof: b64(proof) }));
    const ready = await readyMessage;
    assert.equal(ready.type, "ready");
    assert.equal(ready.payload, undefined);
    assert.equal(ready.token, undefined);
    const shared = nacl.box.before(bytes(serverPublicKey), client.secretKey);
    const rpc = async (id: string, path: string, method = "GET", extra: Record<string, unknown> = {}) => {
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const sealed = nacl.secretbox(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "api.request", params: { path, method, ...extra } })), nonce, shared);
      const responseMessage = message(authSocket);
      authSocket.send(JSON.stringify({ type: "box", nonce: b64(nonce), payload: b64(sealed) }));
      const box = await responseMessage;
      assert.equal(box.type, "box");
      const opened = nacl.secretbox.open(bytes(String(box.payload)), bytes(String(box.nonce)), shared);
      assert.ok(opened);
      return JSON.parse(Buffer.from(opened).toString()) as { id: string; result?: { status: number; body?: unknown; bodyBase64?: string }; error?: { message: string } };
    };
    const allowed = await rpc("projects", "/api/projects");
    assert.equal(allowed.result?.status, 200);
    const preferences = { name: "Bean", customInstructions: "Use concise updates." };
    const savedPreferences = await rpc("settings-save", "/api/settings/orchestrator", "PUT", { body: preferences });
    assert.equal(savedPreferences.result?.status, 200);
    assert.deepEqual(savedPreferences.result?.body, { settings: preferences });
    const fetchedPreferences = await rpc("settings-read", "/api/settings/orchestrator");
    assert.equal(fetchedPreferences.result?.status, 200);
    assert.deepEqual(fetchedPreferences.result?.body, { settings: preferences });
    const projectResult = await rpc("logo-project", "/api/projects", "POST", {
      body: { name: "Logo upload", prefix: "LOG", rootDirectory: dataDir },
    });
    assert.equal(projectResult.result?.status, 201);
    const projectId = (projectResult.result?.body as { project: { id: string } }).project.id;
    const logoPath = `/api/projects/${projectId}/logo`;
    for (const size of [256 * 1024 + 1, 2 * 1024 * 1024]) {
      const png = projectLogoPng(size);
      const logoUpload = await rpc(`logo-upload-${size}`, logoPath, "PUT", {
        bodyBase64: png.toString("base64"), headers: { "content-type": "image/png" },
      });
      assert.equal(logoUpload.result?.status, 200);
      assert.equal((logoUpload.result?.body as { project: { logo: { size: number } } }).project.logo.size, size);
      const logoDownload = await rpc(`logo-download-${size}`, logoPath);
      assert.equal(logoDownload.result?.status, 200);
      assert.deepEqual(Buffer.from(logoDownload.result?.bodyBase64 ?? "", "base64"), png);
    }
    const oversizedLogo = await rpc("logo-oversized", logoPath, "PUT", {
      bodyBase64: projectLogoPng(2 * 1024 * 1024 + 1).toString("base64"), headers: { "content-type": "image/png" },
    });
    assert.equal(oversizedLogo.result?.status, 413);
    assert.deepEqual(oversizedLogo.result?.body, { error: "project_logo_too_large", message: "Logo must be 2 MB or smaller" });
    const firstPoll = await rpc("chat-poll", "/api/orchestrator?poll=1");
    assert.equal(firstPoll.result?.status, 200);
    const snapshot = firstPoll.result?.body as WorkspacePoll;
    assert.ok(snapshot.workspace?.messages);
    const unchangedPoll = await rpc("chat-poll-unchanged", `/api/orchestrator?poll=1&revision=${snapshot.revision}&messagesRevision=${snapshot.messagesRevision}`);
    assert.equal(unchangedPoll.result?.status, 200);
    assert.equal((unchangedPoll.result?.body as WorkspacePoll).workspace, null);
    const initiated = await rpc("attachment-create", "/api/orchestrator/attachments", "POST", {
      body: { filename: "private.txt", mediaType: "text/plain", size: 6 },
    });
    assert.equal(initiated.result?.status, 201);
    const attachmentId = (initiated.result?.body as { attachment: { id: string } }).attachment.id;
    const uploaded = await rpc("attachment-chunk", `/api/attachments/${attachmentId}/chunks/0`, "PUT", {
      bodyBase64: Buffer.from("secret").toString("base64"), headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(uploaded.result?.status, 200);
    assert.equal((await rpc("attachment-complete", `/api/attachments/${attachmentId}/complete`, "POST")).result?.status, 200);
    const downloaded = await rpc("attachment-download", `/api/orchestrator/attachments/${attachmentId}`);
    assert.equal(downloaded.result?.status, 200);
    assert.equal(Buffer.from(downloaded.result?.bodyBase64 ?? "", "base64").toString(), "secret");
    assert.equal((await rpc("attachment-delete", `/api/attachments/${attachmentId}`, "DELETE")).result?.status, 204);
    const device = database.db.prepare("SELECT revoked_at FROM paired_devices WHERE id = ?").get(deviceId) as { revoked_at: string | null };
    assert.equal(device.revoked_at, null);
    const revoke = await rpc("revoke", `/api/devices/${deviceId}/revoke`, "POST");
    assert.equal(revoke.result?.status, 200);
    const denied = await rpc("denied", "/api/projects");
    assert.equal(denied.result?.status, 401);
    authSocket.close();
    await once(authSocket, "close");
  } finally { await app.close(); }
});
