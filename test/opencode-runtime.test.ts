import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureOpenCodeClone, OpenCodeRuntime, type OpenCodeProfileRoots } from "../src/server/opencode-runtime.js";

test("OpenCode profile cloning copies every root and freezes an independent SQLite snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-opencode-clone-"));
  const sourceRoot = join(root, "source");
  const roots: OpenCodeProfileRoots = {
    config: join(sourceRoot, "config"), data: join(sourceRoot, "data"), cache: join(sourceRoot, "cache"),
    state: join(sourceRoot, "state"), temp: join(sourceRoot, "temp"),
  };
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
  writeFileSync(join(roots.config, "opencode.json"), "config-v1");
  writeFileSync(join(roots.data, "auth.json"), "credential-snapshot");
  writeFileSync(join(roots.cache, "models.json"), "cache-v1");
  writeFileSync(join(roots.state, "state.json"), "state-v1");
  writeFileSync(join(roots.temp, "metadata.json"), "temp-v1");
  const sourceDatabase = new Database(join(roots.data, "opencode.db"));
  sourceDatabase.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  sourceDatabase.prepare("INSERT INTO sessions VALUES (?, ?)").run("ses_existing", "Existing history");
  sourceDatabase.close();

  const clone = await ensureOpenCodeClone(join(root, "qahwa"), roots);
  assert.equal(readFileSync(join(clone.roots.config, "opencode.json"), "utf8"), "config-v1");
  assert.equal(readFileSync(join(clone.roots.data, "auth.json"), "utf8"), "credential-snapshot");
  assert.equal(readFileSync(join(clone.roots.cache, "models.json"), "utf8"), "cache-v1");
  assert.equal(readFileSync(join(clone.roots.state, "state.json"), "utf8"), "state-v1");
  assert.equal(readFileSync(join(clone.roots.temp, "metadata.json"), "utf8"), "temp-v1");
  assert.ok(existsSync(join(clone.root, "clone-manifest.json")));
  const clonedDatabase = new Database(join(clone.roots.data, "opencode.db"), { readonly: true });
  assert.deepEqual(clonedDatabase.prepare("SELECT * FROM sessions").all(), [{ id: "ses_existing", title: "Existing history" }]);
  clonedDatabase.close();

  writeFileSync(join(roots.config, "opencode.json"), "config-v2");
  const reopened = await ensureOpenCodeClone(join(root, "qahwa"), roots);
  assert.equal(readFileSync(join(reopened.roots.config, "opencode.json"), "utf8"), "config-v1");
});

test("OpenCode runtime resumes the pinned session and enforces read-only permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-opencode-run-"));
  const dataDir = join(root, "qahwa");
  const clone = join(dataDir, "opencode-profile");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "clone-manifest.json"), "{}");
  const capture = join(root, "capture.json");
  const executable = join(root, "opencode");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
let prompt = "";
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), prompt, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) }));
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses_existing" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_existing", messageID: "msg_reply", part: { text: "Finished safely." } }) + "\\n");
});
`);
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath ?? ""}`;
  try {
    const runtime = new OpenCodeRuntime(dataDir);
    const result = await runtime.run({ ownerKey: "task:1", cwd: root, prompt: "Inspect only", sessionId: "ses_existing", accessMode: "read-only" });
    assert.deepEqual(result, { sessionId: "ses_existing", messageId: "msg_reply", text: "Finished safely." });
    const observed = JSON.parse(readFileSync(capture, "utf8")) as { argv: string[]; prompt: string; config: { permission: Record<string, string> } };
    assert.deepEqual(observed.argv.slice(0, 5), ["run", "--format", "json", "--dir", root]);
    assert.deepEqual(observed.argv.slice(5), ["--session", "ses_existing"]);
    assert.equal(observed.prompt, "Inspect only");
    assert.equal(observed.config.permission.edit, "deny");
    assert.equal(observed.config.permission.bash, "deny");
    runtime.close();
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("OpenCode reports acceptance before the background turn finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "qahwa-opencode-accept-"));
  const dataDir = join(root, "qahwa");
  const clone = join(dataDir, "opencode-profile");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "clone-manifest.json"), "{}");
  const release = join(root, "release");
  const executable = join(root, "opencode");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
let prompt = "";
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses_slow" }) + "\\n");
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_slow", messageID: "msg_slow", part: { text: "Finished later." } }) + "\\n");
    process.exit(0);
  }, 10);
});
`);
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath ?? ""}`;
  try {
    const runtime = new OpenCodeRuntime(dataDir);
    const started = await runtime.start({ ownerKey: "task:slow", cwd: root, prompt: "Wait", sessionId: null, accessMode: "read-only" });
    assert.equal(started.sessionId, "ses_slow");
    let completed = false;
    void started.completion.then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(completed, false, "Acceptance must not wait for the turn to finish");
    writeFileSync(release, "go");
    const result = await started.completion;
    assert.deepEqual(result, { sessionId: "ses_slow", messageId: "msg_slow", text: "Finished later." });
    runtime.close();
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});
