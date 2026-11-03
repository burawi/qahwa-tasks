import assert from "node:assert/strict";
import test from "node:test";
import { documentFromPlainText } from "../src/domain/types.js";
import { coordinationFixture } from "./helpers/orchestrator-replies.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canvasCommentAnchor, canvasCommentTargets } from "../src/domain/canvas-comment.js";

test("shared canvas feedback persists as one thread with all targets and reaches the requested turn", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    const pageId = f.agents.createDesignPage(task.id, "Alignment").selectedDesignPageId!;
    const targets = [{ elementId: "first", label: "First button" }, { elementId: "second", label: "Second button" }];
    const anchor = { ...targets[0]!, targets, revision: 7, pageId };
    const saved = f.tasks.addComment(task.id, { body: documentFromPlainText("Align these buttons"), metadata: { canvas: anchor } }, "user");
    const reloaded = f.tasks.getTask(task.id).comments;
    assert.equal(reloaded.length, 1, "A group is one shared thread");
    assert.deepEqual(canvasCommentAnchor(reloaded[0]!), anchor);
    assert.deepEqual(canvasCommentTargets(canvasCommentAnchor(reloaded[0]!)!), targets);
    assert.equal(f.requests().length, 0, "Saving shared feedback does not start work");
    f.tasks.resolveComment(saved.id, true, "user");
    assert.ok(f.tasks.getTask(task.id).comments[0]!.resolvedAt);
    f.tasks.resolveComment(saved.id, false, "user");
    assert.deepEqual(canvasCommentAnchor(f.tasks.getTask(task.id).comments[0]!), anchor);
    await f.agents.send("task", task.id, "Apply this feedback");
    const prompt = f.requests().find(request => request.method === "turn/start")?.params.input[0].text;
    assert.ok(prompt?.includes(JSON.stringify(anchor)));
  } finally { f.close(); }
});

test("canvas anchor readers preserve legacy targets and reject malformed shared targets", () => {
  const anchor = { elementId: "first", label: "First button", revision: 1, versionId: "current" };
  assert.deepEqual(canvasCommentTargets(canvasCommentAnchor({ metadata: { canvas: anchor } })!), [{ elementId: "first", label: "First button" }]);
  for (const targets of [[], [null], [{ elementId: 1, label: "x" }], [{ elementId: "other", label: "Other" }], [anchor, anchor]]) {
    assert.equal(canvasCommentAnchor({ metadata: { canvas: { ...anchor, targets } } }), null);
  }
});

test("a requested chat turn receives saved canvas comments with IDs and revision context", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    const pageId = f.agents.createDesignPage(task.id, "Purchase").selectedDesignPageId!;
    const comment = f.tasks.addComment(task.id, {
      body: documentFromPlainText("Make this button easier to read"),
      metadata: { canvas: { elementId: "purchase", label: "purchase (button)", revision: 5, pageId } },
    }, "user");
    assert.equal(f.requests().length, 0, "Saved feedback alone does not start Codex");
    await f.agents.send("task", task.id, "Please address the canvas comments");
    const turn = f.requests().find(request => request.method === "turn/start");
    const prompt = turn?.params.input[0].text;
    assert.ok(prompt);
    assert.ok(prompt.includes(comment.id));
    assert.match(prompt, /Make this button easier to read/);
    assert.match(prompt, /"elementId":"purchase"/);
    assert.match(prompt, /"revision":5/);
    assert.match(prompt, /saving alone does not authorize work/);
    assert.match(prompt, /resolve_comment/);
    assert.match(prompt, /do not close the task/);
  } finally { f.close(); }
});

test("MCP exposes every shared canvas target and lets the bot resolve and reopen saved feedback", async () => {
  const f = coordinationFixture();
  const client = new Client({ name: "canvas-comment-test", version: "1" });
  try {
    const task = f.task();
    const anchor = { elementId: "purchase", label: "purchase (button)", revision: 5, versionId: "current", targets: [
      { elementId: "purchase", label: "purchase (button)" }, { elementId: "checkout", label: "checkout (button)" },
    ] };
    const comment = f.tasks.addComment(task.id, { body: documentFromPlainText("Increase contrast"), metadata: { canvas: anchor } }, "user");
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/index.ts"],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), DATA_DIR: f.root },
    }));
    const get = async (includeResolvedHistory = false) => {
      const result = await client.callTool({ name: "get_task", arguments: { taskId: task.humanId, includeResolvedHistory } });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    assert.deepEqual((await get()).unresolvedComments[0].canvas, anchor);
    const resolved = await client.callTool({ name: "resolve_comment", arguments: { commentId: comment.id, resolved: true, reply: "Contrast adjusted" } });
    assert.ok(!resolved.isError);
    assert.deepEqual((await get()).unresolvedComments, []);
    const history = await get(true);
    assert.equal(history.resolvedComments[0].id, comment.id);
    assert.deepEqual(history.resolvedComments[0].canvas, anchor);
    assert.equal(history.resolvedComments[0].replies[0].author, "codex");
    await client.callTool({ name: "resolve_comment", arguments: { commentId: comment.id, resolved: false } });
    assert.equal((await get()).unresolvedComments[0].id, comment.id);
    assert.equal(f.tasks.getTask(task.id).status, "todo");
    assert.equal(f.requests().length, 0);
  } finally { await client.close(); f.close(); }
});
