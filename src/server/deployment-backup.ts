import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "./config.js";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Snapshot the existing database without running AppDatabase schema changes. */
export async function createDeploymentBackup(
  config: Pick<Config, "dataDir" | "backupDir">,
  taskId: string,
  now = new Date(),
): Promise<string> {
  const humanId = taskId.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*-\d+$/.test(humanId)) throw new Error("A valid task identifier is required for deployment backup");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const source = join(config.dataDir, "qahwa-tasks.sqlite");
  // Missing data must fail rather than silently create an empty production database.
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
    // mkdtemp allocates a fresh private directory exclusively, even for simultaneous
    // deployments in the same millisecond. Daily/weekly rotation ignores this namespace.
    const directory = mkdtempSync(join(config.backupDir, `pre-deploy-${humanId}-${stamp}-`));
    chmodSync(directory, 0o700);
    const snapshot = join(directory, "database.sqlite");
    writeFileSync(snapshot, "", { flag: "wx", mode: 0o600 });
    await database.backup(snapshot);
    chmodSync(snapshot, 0o600);

    const sourceLogos = join(config.dataDir, "project-logos");
    const logos = join(directory, "project-logos");
    if (existsSync(sourceLogos)) cpSync(sourceLogos, logos, { recursive: true, errorOnExist: true, force: false });

    const saved = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      if (saved.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Deployment snapshot failed SQLite validation");
      const columns = saved.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      if (columns.some(column => column.name === "logo_filename")) {
        const references = saved.prepare("SELECT logo_filename FROM projects WHERE logo_filename IS NOT NULL").all() as Array<{ logo_filename: string }>;
        for (const { logo_filename: name } of references) {
          if (!name || basename(name) !== name || !existsSync(join(logos, name))) {
            throw new Error("Deployment snapshot is missing a referenced project logo");
          }
        }
      }
    } finally { saved.close(); }

    const logoFiles = existsSync(logos) ? readdirSync(logos).map(name => {
      const path = join(logos, name);
      if (!statSync(path).isFile()) throw new Error("Unexpected directory in deployment logo snapshot");
      chmodSync(path, 0o600);
      return { file: `project-logos/${name}`, bytes: statSync(path).size, sha256: sha256(path) };
    }) : [];
    // A manifest is written only after both the database and its referenced logos
    // validate. Incomplete bundles cannot be mistaken for a successful preflight.
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      status: "complete", taskId: humanId, createdAt: now.toISOString(), sourceDatabase: source,
      database: { file: "database.sqlite", bytes: statSync(snapshot).size, sha256: sha256(snapshot) },
      projectLogos: logoFiles,
      coverage: "SQLite and project logos; attachment files and external runtime configuration are not included",
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return directory;
  } finally { database.close(); }
}
