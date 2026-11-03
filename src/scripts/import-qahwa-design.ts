import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { documentFromPlainText, type DesignDocument } from "../domain/types.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/database.js";
import { TaskService } from "../server/task-service.js";

const config = loadConfig();
const sourcePath = resolve(process.env.QAHWA_DESIGN_DB?.trim() || "/home/burawi/.local/share/qahwa-design/qahwa.sqlite");
const apply = process.argv.includes("--apply");
if (!existsSync(sourcePath)) throw new Error(`Qahwa Design database not found: ${sourcePath}`);

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const target = new AppDatabase(config);
try {
  const designs = source.prepare("SELECT * FROM projects ORDER BY updated_at").all() as Array<{
    id: string; name: string; document: string; revision: number; thread_id: string | null;
    workspace_path: string | null; created_at: string; updated_at: string;
  }>;
  const projects = target.db.prepare("SELECT id, name, root_directory FROM projects WHERE archived_at IS NULL").all() as Array<{
    id: string; name: string; root_directory: string;
  }>;
  const plan = designs.map((design) => ({
    design,
    project: projects.find((project) => project.root_directory === design.workspace_path),
  }));
  for (const entry of plan) {
    process.stdout.write(`${entry.design.name} r${entry.design.revision} -> ${entry.project?.name ?? "NO MATCH"} (${entry.design.workspace_path ?? "no workspace"})\n`);
  }
  if (!apply) {
    process.stdout.write(`Dry run only. Re-run with --apply to import ${plan.filter((entry) => entry.project).length} design(s).\n`);
    process.exitCode = plan.some((entry) => !entry.project) ? 2 : 0;
  } else {
    const unmatched = plan.filter((entry) => !entry.project);
    if (unmatched.length) throw new Error("Every Qahwa Design project must match an active task project root before import");
    mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
    const backupPath = join(config.backupDir, `pre-qahwa-design-import-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
    await target.db.backup(backupPath);
    const tasks = new TaskService(target);
    const transaction = target.db.transaction(() => {
      for (const entry of plan) {
        const project = entry.project!;
        const existing = target.db.prepare("SELECT id FROM tasks WHERE project_id = ? AND title = ? COLLATE NOCASE")
          .get(project.id, `Design: ${entry.design.name}`) as { id: string } | undefined;
        if (existing) throw new Error(`Import target already exists for ${entry.design.name}`);
        const task = tasks.createTask({
          projectId: project.id,
          title: `Design: ${entry.design.name}`,
          description: documentFromPlainText(`Continue the imported ${entry.design.name} design canvas. Imported from Qahwa Design revision ${entry.design.revision}.`),
        }, "system");
        const document = JSON.parse(entry.design.document) as DesignDocument;
        target.db.prepare("INSERT INTO design_pages (id, task_id, name, document_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(`canvas:${task.id}`, task.id, document.artboard.name || entry.design.name, JSON.stringify(document), entry.design.revision, entry.design.created_at, entry.design.updated_at);
        target.db.prepare("INSERT INTO design_page_selection (task_id, page_id) VALUES (?, ?)").run(task.id, `canvas:${task.id}`);
        const versions = source.prepare("SELECT * FROM versions WHERE project_id = ? ORDER BY created_at").all(entry.design.id) as Array<{
          id: string; name: string; document: string; revision: number; created_at: string;
        }>;
        const insertVersion = target.db.prepare("INSERT INTO design_pages (id, task_id, name, document_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
        for (const version of versions) insertVersion.run(version.id || randomUUID(), task.id, version.name, version.document, version.revision, version.created_at, version.created_at);
        const timestamp = new Date().toISOString();
        target.db.prepare(`
          INSERT INTO agent_sessions (id, owner_type, owner_id, thread_id, surface, run_state, created_at, updated_at)
          VALUES (?, 'task', ?, ?, 'design', 'idle', ?, ?)
        `).run(randomUUID(), task.id, entry.design.thread_id, timestamp, timestamp);
        target.db.prepare("UPDATE task_presence SET message = 'Design imported', tone = 'green', reason = ?, updated_at = ? WHERE task_id = ?")
          .run(`Imported Qahwa Design revision ${entry.design.revision}`, timestamp, task.id);
      }
    });
    transaction();
    process.stdout.write(`Imported ${plan.length} design(s). Backup: ${backupPath}\n`);
  }
} finally {
  source.close();
  target.close();
}
