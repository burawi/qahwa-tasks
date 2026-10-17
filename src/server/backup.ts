import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { AppDatabase } from "./database.js";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function rotate(directory: string, prefix: string, keep: number): void {
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
    .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(keep)) {
    unlinkSync(join(directory, file.name));
    rmSync(join(directory, `${basename(file.name, ".sqlite")}.assets`), { recursive: true, force: true });
  }
}

function backupLogos(database: AppDatabase, backupDir: string, sqlitePath: string): void {
  const source = join(database.dataDir, "project-logos");
  if (!existsSync(source)) return;
  const assetRoot = join(backupDir, `${basename(sqlitePath, ".sqlite")}.assets`);
  rmSync(assetRoot, { recursive: true, force: true });
  mkdirSync(assetRoot, { recursive: true, mode: 0o700 });
  cpSync(source, join(assetRoot, "project-logos"), { recursive: true });
}

export async function createBackup(database: AppDatabase, backupDir: string, now = new Date()): Promise<string> {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dailyPath = join(backupDir, `daily-${isoDate(now)}.sqlite`);
  await database.db.backup(dailyPath);
  chmodSync(dailyPath, 0o600);
  backupLogos(database, backupDir, dailyPath);
  if (now.getUTCDay() === 0) {
    const weeklyPath = join(backupDir, `weekly-${isoDate(now)}.sqlite`);
    await database.db.backup(weeklyPath);
    chmodSync(weeklyPath, 0o600);
    backupLogos(database, backupDir, weeklyPath);
  }
  rotate(backupDir, "daily-", 30);
  rotate(backupDir, "weekly-", 12);
  return dailyPath;
}

export function scheduleBackups(database: AppDatabase, backupDir: string): NodeJS.Timeout {
  const run = () => void createBackup(database, backupDir).catch((error) => console.error("Backup failed", error));
  run();
  return setInterval(run, 24 * 60 * 60 * 1000);
}
