import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import type { AppDatabase } from "./database.js";

export interface SessionUser { actor: "user"; deviceId: string }

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Internal sessions exist only inside an authenticated encrypted device connection. */
export class AuthService {
  constructor(private readonly database: AppDatabase, private readonly sessionDays: number) {}

  createSession(userAgent: string | null, ipAddress: string | null, deviceId: string): { token: string; expires: Date } {
    const token = randomBytes(32).toString("base64url");
    const timestamp = new Date();
    const expires = new Date(timestamp.getTime() + this.sessionDays * 86_400_000);
    this.database.db.prepare(`
      INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, user_agent, ip_address, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hashToken(token), timestamp.toISOString(), timestamp.toISOString(), expires.toISOString(), userAgent, ipAddress, deviceId);
    return { token, expires };
  }

  revokeToken(token: string): void {
    this.database.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  requireSession(request: FastifyRequest): SessionUser {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) throw new DomainError("Encrypted device session required", "authentication_required", 401);
    const row = this.database.db.prepare("SELECT expires_at, device_id FROM sessions WHERE token_hash = ?").get(hashToken(token)) as
      | { expires_at: string; device_id: string | null }
      | undefined;
    if (!row?.device_id || new Date(row.expires_at).getTime() <= Date.now()) {
      if (row) this.revokeToken(token);
      throw new DomainError("Device session expired", "session_expired", 401);
    }
    this.database.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(new Date().toISOString(), hashToken(token));
    return { actor: "user", deviceId: row.device_id };
  }
}
