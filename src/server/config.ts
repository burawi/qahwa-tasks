import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  backupDir: string;
  sessionDays: number;
  qahwaNotifyUrl: string;
  qahwaNotifyTokenFile: string;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.DATA_DIR?.trim() || "./data");
  return {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: integer("PORT", 3022, 1, 65535),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:3022").replace(/\/$/, ""),
    dataDir,
    backupDir: resolve(process.env.BACKUP_DIR?.trim() || `${dataDir}/backups`),
    sessionDays: integer("SESSION_DAYS", 365, 1, 730),
    qahwaNotifyUrl: (process.env.QAHWA_NOTIFY_URL?.trim() || "http://127.0.0.1:3020").replace(/\/$/, ""),
    qahwaNotifyTokenFile: resolve(
      process.env.QAHWA_NOTIFY_TOKEN_FILE?.trim() || "/home/burawi/.config/qahwa-notify/send.token",
    ),
  };
}
