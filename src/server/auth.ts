import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import type { AppDatabase } from "./database.js";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "qahwa_tasks_session";
const KEY_LENGTH = 64;

interface PasswordRecord {
  salt: string;
  hash: string;
}

export interface SessionUser {
  actor: "user";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) {
    throw new DomainError("Password must be between 12 and 256 characters", "invalid_password");
  }
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return JSON.stringify({ salt: salt.toString("base64"), hash: key.toString("base64") } satisfies PasswordRecord);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const record = JSON.parse(encoded) as PasswordRecord;
    const expected = Buffer.from(record.hash, "base64");
    const actual = (await scrypt(password, Buffer.from(record.salt, "base64"), expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export class AuthService {
  constructor(
    private readonly database: AppDatabase,
    private readonly sessionDays: number,
    private readonly secureCookies: boolean,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.database.setting("password_hash"));
  }

  async setPassword(password: string): Promise<void> {
    this.database.setSetting("password_hash", await hashPassword(password));
    this.database.db.prepare("DELETE FROM sessions").run();
  }

  createSetupToken(): { token: string; expiresAt: string } {
    if (this.isConfigured()) throw new DomainError("Application is already configured", "already_configured", 409);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    this.database.setSetting("setup_token", JSON.stringify({ hash: hashToken(token), expiresAt }));
    return { token, expiresAt };
  }

  async setup(password: string, token: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (this.isConfigured()) throw new DomainError("Application is already configured", "already_configured", 409);
    const encoded = this.database.setting("setup_token");
    let record: { hash: string; expiresAt: string } | null = null;
    try { record = encoded ? JSON.parse(encoded) as { hash: string; expiresAt: string } : null; } catch { record = null; }
    const provided = Buffer.from(hashToken(token));
    const expected = Buffer.from(record?.hash ?? "");
    const matches = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!record || !matches || new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new DomainError("Setup link is invalid or expired", "invalid_setup_token", 401);
    }
    await this.setPassword(password);
    this.database.deleteSetting("setup_token");
    await this.login(password, request, reply);
  }

  async login(password: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const encoded = this.database.setting("password_hash");
    if (!encoded || !(await verifyPassword(password, encoded))) {
      throw new DomainError("Invalid password", "invalid_credentials", 401);
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + this.sessionDays * 86_400_000);
    this.database.db.prepare(`
      INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hashToken(token), now.toISOString(), now.toISOString(), expires.toISOString(), request.headers["user-agent"] ?? null, request.ip);
    this.setCookie(reply, token, expires);
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies[COOKIE_NAME];
    if (token) this.database.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    reply.clearCookie(COOKIE_NAME, { path: "/" });
  }

  requireSession(request: FastifyRequest, reply: FastifyReply): SessionUser {
    const token = request.cookies[COOKIE_NAME];
    if (!token) throw new DomainError("Authentication required", "authentication_required", 401);
    const row = this.database.db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hashToken(token)) as
      | { expires_at: string }
      | undefined;
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
      if (row) this.database.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
      reply.clearCookie(COOKIE_NAME, { path: "/" });
      throw new DomainError("Session expired", "session_expired", 401);
    }
    this.refreshSession(token, row.expires_at, reply);
    return { actor: "user" };
  }

  authenticated(request: FastifyRequest): boolean {
    const token = request.cookies[COOKIE_NAME];
    if (!token) return false;
    const row = this.database.db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?").get(
      hashToken(token),
      new Date().toISOString(),
    );
    return Boolean(row);
  }

  revokeAll(): void {
    this.database.db.prepare("DELETE FROM sessions").run();
  }

  private refreshSession(token: string, currentExpiry: string, reply: FastifyReply): void {
    const remaining = new Date(currentExpiry).getTime() - Date.now();
    const refreshThreshold = this.sessionDays * 86_400_000 * 0.25;
    const now = new Date();
    if (remaining > refreshThreshold) {
      this.database.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now.toISOString(), hashToken(token));
      return;
    }
    const expires = new Date(now.getTime() + this.sessionDays * 86_400_000);
    this.database.db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(
      now.toISOString(), expires.toISOString(), hashToken(token),
    );
    this.setCookie(reply, token, expires);
  }

  private setCookie(reply: FastifyReply, token: string, expires: Date): void {
    reply.setCookie(COOKIE_NAME, token, {
      path: "/",
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: "lax",
      expires,
    });
  }
}
