import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackup } from "../src/server/backup.js";
import type { Config } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { TaskService } from "../src/server/task-service.js";

test("database backups include project logo assets", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-logo-backup-"));
  const root = join(dataDir, "project");
  const backupDir = join(dataDir, "backups");
  mkdirSync(root);
  const config: Config = {
    host: "127.0.0.1", port: 3022, publicBaseUrl: "https://tasks.qahwa.pro", dataDir, backupDir,
    sessionDays: 365, qahwaNotifyUrl: "http://127.0.0.1:3020", qahwaNotifyTokenFile: join(dataDir, "token"),
  };
  const database = new AppDatabase(config);
  try {
    const tasks = new TaskService(database);
    const project = tasks.createProject({ name: "Backup logo", prefix: "BKP", rootDirectory: root }, "user");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    tasks.uploadProjectLogo(project.id, png, "image/png", "user");
    const date = new Date("2026-10-17T12:00:00.000Z");
    const sqlite = await createBackup(database, backupDir, date);
    const filename = tasks.projectLogoFile(project.id).path.split("/").at(-1) ?? "";
    assert.equal(existsSync(sqlite), true);
    assert.equal(existsSync(join(backupDir, "daily-2026-10-17.assets", "project-logos", filename)), true);
  } finally { database.close(); }
});
