import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes the task workflow tools", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qahwa-tasks-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server/mcp/index.js"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      DATA_DIR: dataDir,
      BACKUP_DIR: join(dataDir, "backups"),
      PUBLIC_BASE_URL: "https://tasks.qahwa.pro",
      QAHWA_NOTIFY_TOKEN_FILE: join(dataDir, "missing-token"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(`[mcp] ${String(chunk)}`));
  const client = new Client({ name: "qahwa-tasks-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const required of ["list_tasks", "get_task", "create_tasks", "start_task", "submit_for_review", "close_task"]) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /\[\]/);
  } finally {
    await client.close();
  }
});
