import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDeploymentBackup } from "../src/server/deployment-backup.js";
import { createBackup } from "../src/server/backup.js";
import type { AppDatabase } from "../src/server/database.js";

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "qahwa-deploy-backup-"));
  const dataDir = join(root, "data"), backupDir = join(root, "backups");
  mkdirSync(join(dataDir, "project-logos"), { recursive: true });
  const path = join(dataDir, "qahwa-tasks.sqlite");
  const db = new Database(path);
  // An old, minimal schema deliberately incompatible with AppDatabase's migrations.
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    INSERT INTO tasks VALUES ('task', 'Before deployment');
    CREATE TABLE projects (id TEXT PRIMARY KEY, logo_filename TEXT);
    INSERT INTO projects VALUES ('project', 'logo.png');
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO app_settings VALUES ('setup_token', 'synthetic value must survive');`);
  writeFileSync(join(dataDir, "project-logos/logo.png"), "original logo");
  t.after(() => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, backupDir, path, db };
}

function readTitle(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return (db.prepare("SELECT title FROM tasks WHERE id = 'task'").get() as { title: string }).title; }
  finally { db.close(); }
}

test("deployment snapshot preserves the existing schema and logos before any migration", async t => {
  const f = fixture(t);
  const before = hash(f.path);
  const directory = await createDeploymentBackup(f, "qah-0017", new Date("2026-10-28T18:00:00Z"));
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const snapshot = join(directory, "database.sqlite");
  assert.match(directory, /pre-deploy-QAH-0017-2026-10-28T18-00-00-000Z-/);
  assert.equal(hash(f.path), before, "The source database is not migrated or rewritten");
  const saved = new Database(snapshot, { readonly: true });
  try {
    assert.deepEqual(saved.prepare("PRAGMA table_info(tasks)").all().map((column: any) => column.name), ["id", "title"]);
    assert.equal((saved.prepare("SELECT value FROM app_settings WHERE key = 'setup_token'").get() as { value: string }).value, "synthetic value must survive");
  } finally { saved.close(); }
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.taskId, "QAH-0017");
  assert.equal(manifest.database.sha256, hash(snapshot));
  assert.equal(manifest.projectLogos[0].sha256, hash(join(directory, "project-logos/logo.png")));
  assert.equal(readFileSync(join(directory, "project-logos/logo.png"), "utf8"), "original logo");
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of ["database.sqlite", "manifest.json", "project-logos/logo.png"]) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
});

test("same-millisecond deployments allocate exclusive bundles; later daily backups and rotation preserve them", async t => {
  const f = fixture(t);
  const date = new Date("2026-10-28T18:00:00Z");
  const [first, second] = await Promise.all([createDeploymentBackup(f, "QAH-0017", date), createDeploymentBackup(f, "QAH-0017", date)]);
  assert.notEqual(first, second);
  const sqliteHash = hash(join(first, "database.sqlite")), logoHash = hash(join(first, "project-logos/logo.png"));
  f.db.prepare("UPDATE tasks SET title = 'After deployment'").run();
  writeFileSync(join(f.dataDir, "project-logos/logo.png"), "replacement logo");
  // createBackup only needs db/dataDir; avoid invoking any application startup.
  const daily = await createBackup({ db: f.db, dataDir: f.dataDir } as AppDatabase, f.backupDir, date);
  assert.equal(readTitle(daily), "After deployment");
  assert.equal(readTitle(join(first, "database.sqlite")), "Before deployment");
  assert.equal(hash(join(first, "database.sqlite")), sqliteHash);
  assert.equal(hash(join(first, "project-logos/logo.png")), logoHash);
  for (let day = 1; day <= 31; day++) writeFileSync(join(f.backupDir, `daily-2000-01-${String(day).padStart(2, "0")}.sqlite`), "disposable retention fixture");
  await createBackup({ db: f.db, dataDir: f.dataDir } as AppDatabase, f.backupDir, date);
  assert.equal(readdirSync(f.backupDir).filter(name => name.startsWith("daily-") && name.endsWith(".sqlite")).length, 30);
  assert.equal(hash(join(first, "database.sqlite")), sqliteHash);
  assert.equal(hash(join(first, "project-logos/logo.png")), logoHash);
  assert.ok(existsSync(join(second, "manifest.json")));
});

test("deployment snapshots include committed WAL data from a running writer", async t => {
  const f = fixture(t);
  f.db.pragma("journal_mode = WAL");
  f.db.pragma("wal_autocheckpoint = 0");
  f.db.prepare("UPDATE tasks SET title = 'Committed in WAL'").run();
  assert.ok(statSync(`${f.path}-wal`).size > 0);
  const directory = await createDeploymentBackup(f, "QAH-0017");
  assert.equal(readTitle(join(directory, "database.sqlite")), "Committed in WAL");
  assert.equal(readTitle(f.path), "Committed in WAL");
});

test("missing source, invalid task ID and missing referenced logos fail rather than report a usable snapshot", async t => {
  const f = fixture(t);
  await assert.rejects(createDeploymentBackup(f, "../unsafe"), /valid task identifier/);
  assert.equal(existsSync(f.backupDir), false);
  await assert.rejects(createDeploymentBackup({ dataDir: join(f.root, "absent"), backupDir: f.backupDir }, "QAH-0017"));
  assert.equal(existsSync(f.backupDir), false);
  rmSync(join(f.dataDir, "project-logos/logo.png"));
  await assert.rejects(createDeploymentBackup(f, "QAH-0017"), /missing a referenced project logo/);
  const incomplete = readdirSync(f.backupDir);
  assert.equal(incomplete.length, 1);
  assert.equal(existsSync(join(f.backupDir, incomplete[0]!, "manifest.json")), false);
});

function runDeployment(f: ReturnType<typeof fixture>, failure: "build" | "backup" | null = null) {
  const bin = join(f.root, "bin"); mkdirSync(bin);
  if (failure === "backup") rmSync(join(f.dataDir, "project-logos/logo.png"));
  writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.QAHWA_DEPLOY_FIXTURE;
const backups = path.join(root, 'backups');
const names = fs.readdirSync(backups).filter(name => name.startsWith('pre-deploy-'));
if (names.length !== 1 || !fs.existsSync(path.join(backups, names[0], 'manifest.json'))) process.exit(9);
fs.writeFileSync(path.join(root, 'build-ran'), JSON.stringify(process.argv.slice(2)));
process.exit(${failure === "build" ? 7 : 0});
`, { mode: 0o700 });
  return spawnSync(process.execPath, ["--import", "tsx", resolve("src/scripts/deploy-self.ts"), "QAH-0017"], {
    cwd: resolve("."), encoding: "utf8", timeout: 15_000,
    env: { ...process.env, DATA_DIR: f.dataDir, BACKUP_DIR: f.backupDir,
      QAHWA_DEPLOY_FIXTURE: f.root, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("deployment entrypoint verifies the snapshot before build and only then requests a deferred restart", t => {
  const f = fixture(t);
  const result = runDeployment(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, "build-ran"), "utf8")), ["run", "build"]);
  const request = JSON.parse(readFileSync(join(f.dataDir, "self-deploy-request.json"), "utf8"));
  assert.equal(request.humanId, "QAH-0017");
  assert.match(result.stdout, /Pre-deployment snapshot verified/);
  assert.match(result.stdout, /restart after this Codex turn completes/);
  assert.equal(readTitle(f.path), "Before deployment");
});

test("backup failure blocks build and restart; build failure retains recovery copy without requesting restart", t => {
  for (const failure of ["backup", "build"] as const) {
    const f = fixture(t);
    const result = runDeployment(f, failure);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(f.dataDir, "self-deploy-request.json")), false);
    assert.equal(existsSync(join(f.root, "build-ran")), failure === "build");
    const bundle = join(f.backupDir, readdirSync(f.backupDir)[0]!);
    assert.equal(existsSync(join(bundle, "manifest.json")), failure === "build");
    if (failure === "build") assert.equal(readTitle(join(bundle, "database.sqlite")), "Before deployment");
  }
});
