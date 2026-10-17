import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitApprovalOutput } from "../src/web/components/TaskDetail.js";

const proposal = {
  message: "feat: guarded commits",
  repositoryRoot: "/srv/project",
  baseRevision: "a".repeat(40),
  files: ["src/commit.ts", "test/commit.test.ts"],
  releaseNote: "Adds guarded reviewed commits.",
  status: "pending" as const,
  commitHash: null,
};

test("commit approval displays exact scope and no push or deploy promise", () => {
  const html = renderToStaticMarkup(React.createElement(CommitApprovalOutput, { approval: proposal, eligible: true }));
  assert.match(html, /Approve commit/);
  assert.match(html, /feat: guarded commits/);
  assert.match(html, /\/srv\/project/);
  assert.match(html, new RegExp("a{40}"));
  assert.match(html, /src\/commit\.ts/);
  assert.match(html, /does not start Codex, push, publish, or deploy/);
});

test("commit approval disables stale task states and shows completed commit hashes", () => {
  const unavailable = renderToStaticMarkup(React.createElement(CommitApprovalOutput, { approval: proposal, eligible: false }));
  assert.match(unavailable, /disabled/);
  assert.match(unavailable, /available while this task is in review/);
  const committed = renderToStaticMarkup(React.createElement(CommitApprovalOutput, {
    approval: { ...proposal, status: "committed", commitHash: "b".repeat(40) }, eligible: true,
  }));
  assert.match(committed, /Approved commit/);
  assert.match(committed, new RegExp("b{40}"));
  assert.doesNotMatch(committed, /Approve commit<\/button>/);
});
