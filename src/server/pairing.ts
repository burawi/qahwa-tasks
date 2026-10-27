import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import type WebSocket from "ws";
import type { AppDatabase } from "./database.js";
import type { AuthService } from "./auth.js";

const b64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64"));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const now = (): string => new Date().toISOString();

interface ServerKeys { publicKey: string; secretKey: string }

export class PairingService {
  private readonly keys: ServerKeys;

  constructor(private readonly database: AppDatabase, private readonly auth: AuthService, private readonly publicBaseUrl: string) {
    this.keys = this.serverKeys();
  }

  createLink(): { uri: string; expiresAt: string } {
    const id = randomUUID();
    const secret = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    this.database.db.prepare("INSERT INTO pairing_grants (id, secret_hash, expires_at) VALUES (?, ?, ?)")
      .run(id, hash(secret), expiresAt);
    const url = new URL(this.publicBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/rpc";
    url.search = "";
    return {
      uri: `qahwa://pair?endpoint=${encodeURIComponent(url.toString())}&grant=${encodeURIComponent(`${id}.${secret}`)}&serverKey=${encodeURIComponent(this.keys.publicKey)}&v=1`,
      expiresAt,
    };
  }

  register(app: FastifyInstance): void {
    app.get("/rpc", { websocket: true }, (socket, request) =>
      this.connection(app, socket, request.headers["user-agent"] ?? null, request.ip));
  }

  private connection(app: FastifyInstance, socket: WebSocket, userAgent: string | null, ipAddress: string): void {
    let challenge: string | null = null;
    let device: { id: string; public_key: string } | null = null;
    let sharedKey: Uint8Array | null = null;
    let internalToken: string | null = null;
    const sendEncrypted = (payload: unknown) => {
      if (!sharedKey) throw new Error("Device is not authenticated");
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const sealed = nacl.secretbox(Buffer.from(JSON.stringify(payload)), nonce, sharedKey);
      socket.send(JSON.stringify({ type: "box", nonce: b64(nonce), payload: b64(sealed) }));
    };
    socket.on("message", (raw) => void (async () => {
      let requestId: string | undefined;
      try {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type === "pair") {
          const [id, token] = String(message.grant ?? "").split(".");
          const grant = this.database.db.prepare("SELECT * FROM pairing_grants WHERE id = ?").get(id) as
            | { secret_hash: string; expires_at: string; used_at: string | null } | undefined;
          if (!id || !token || !grant || grant.used_at || grant.expires_at <= now() || hash(token) !== grant.secret_hash) {
            throw new Error("Pairing link is invalid or expired");
          }
          const deviceId = String(message.deviceId ?? "").slice(0, 120);
          const publicKey = String(message.publicKey ?? "");
          if (!deviceId || bytes(publicKey).length !== nacl.box.publicKeyLength) throw new Error("Invalid device identity");
          const timestamp = now();
          this.database.db.prepare(`
            INSERT INTO paired_devices (id, name, public_key, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key,
              last_seen_at = excluded.last_seen_at, revoked_at = NULL
          `).run(deviceId, String(message.deviceName ?? "Browser").slice(0, 120), publicKey, timestamp, timestamp);
          this.database.db.prepare("UPDATE pairing_grants SET used_at = ? WHERE id = ?").run(timestamp, id);
          socket.send(JSON.stringify({ type: "paired", serverPublicKey: this.keys.publicKey }));
          return;
        }
        if (message.type === "hello") {
          device = this.database.db.prepare("SELECT id, public_key FROM paired_devices WHERE id = ? AND revoked_at IS NULL")
            .get(String(message.deviceId ?? "")) as typeof device;
          if (!device) throw new Error("Unknown or revoked device");
          challenge = randomBytes(32).toString("base64");
          socket.send(JSON.stringify({ type: "challenge", challenge }));
          return;
        }
        if (message.type === "auth" && device && challenge) {
          const opened = nacl.box.open(bytes(String(message.proof ?? "")), bytes(String(message.nonce ?? "")), bytes(device.public_key), bytes(this.keys.secretKey));
          if (!opened || Buffer.from(opened).toString() !== challenge) throw new Error("Authentication failed");
          sharedKey = nacl.box.before(bytes(device.public_key), bytes(this.keys.secretKey));
          internalToken = this.auth.createSession(userAgent, ipAddress, device.id).token;
          this.database.db.prepare("UPDATE paired_devices SET last_seen_at = ? WHERE id = ?").run(now(), device.id);
          socket.send(JSON.stringify({ type: "ready", protocolVersion: 1, capabilities: ["encrypted-api", "projects", "tasks", "codex"] }));
          challenge = null;
          return;
        }
        if (message.type === "box" && sharedKey && internalToken && device) {
          const opened = nacl.secretbox.open(bytes(String(message.payload ?? "")), bytes(String(message.nonce ?? "")), sharedKey);
          if (!opened) throw new Error("Invalid encrypted message");
          const request = JSON.parse(Buffer.from(opened).toString()) as {
            id?: string;
            method?: string;
            params?: { path?: string; method?: string; body?: unknown; bodyBase64?: string; headers?: Record<string, string> };
          };
          requestId = request.id;
          if (!request.id || request.method !== "api.request") throw new Error("Unknown encrypted request");
          const path = String(request.params?.path ?? "");
          const method = String(request.params?.method ?? "GET").toUpperCase();
          if (!path.startsWith("/api/") || path.startsWith("/api/auth/") || path === "/api/devices/pairing-link") {
            throw new Error("Encrypted request path is not allowed");
          }
          const headers: Record<string, string> = {
            authorization: `Bearer ${internalToken}`,
            origin: this.publicBaseUrl,
            ...(request.params?.headers ?? {}),
          };
          let payload: string | Buffer | undefined;
          if (request.params?.bodyBase64) payload = Buffer.from(request.params.bodyBase64, "base64");
          else if (request.params?.body !== undefined) {
            headers["content-type"] ??= "application/json";
            payload = JSON.stringify(request.params.body);
          }
          const response = await app.inject({ method: method as "GET", url: path, headers, payload });
          const contentType = String(response.headers["content-type"] ?? "");
          const isJson = contentType.includes("json");
          const body = isJson ? (() => { try { return response.json(); } catch { return {}; } })() : undefined;
          sendEncrypted({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              status: response.statusCode,
              contentType,
              body,
              bodyBase64: isJson ? undefined : response.rawPayload.toString("base64"),
            },
          });
          return;
        }
        throw new Error("Unexpected pairing message");
      } catch (error) {
        const detail = { message: error instanceof Error ? error.message : "Request failed" };
        if (sharedKey) sendEncrypted({ jsonrpc: "2.0", id: requestId, error: detail });
        else socket.send(JSON.stringify({ type: "error", ...detail }));
      }
    })());
    socket.on("close", () => {
      if (internalToken) this.auth.revokeToken(internalToken);
    });
  }

  private serverKeys(): ServerKeys {
    const stored = this.database.setting("pairing_server_keys");
    if (stored) {
      try { return JSON.parse(stored) as ServerKeys; } catch { /* regenerate invalid local state */ }
    }
    const pair = nacl.box.keyPair();
    const keys = { publicKey: b64(pair.publicKey), secretKey: b64(pair.secretKey) };
    this.database.setSetting("pairing_server_keys", JSON.stringify(keys));
    return keys;
  }
}
