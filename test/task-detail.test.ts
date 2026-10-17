import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RelatedTaskList, statusActions } from "../src/web/components/TaskDetail.js";

test("in-review task actions omit Request changes and retain Mark completed", () => {
  assert.deepEqual(statusActions("in_review"), [
    { label: "Mark completed", to: "closed", outcome: "completed", kind: "primary" },
  ]);
});

test("related-task cards expose project, current status, and navigation target", () => {
  const html = renderToStaticMarkup(RelatedTaskList({
    tasks: [{
      id: "uuid", humanId: "MAJ-0007", projectId: "project", projectName: "Majenna", projectPrefix: "MAJ",
      title: "Publish release", status: "in_review", outcome: null,
    }],
    onNavigate: () => undefined,
  }));
  assert.match(html, /href="\/tasks\/MAJ-0007"/);
  assert.match(html, /Majenna/);
  assert.match(html, /Publish release/);
  assert.match(html, /In review/);
});
