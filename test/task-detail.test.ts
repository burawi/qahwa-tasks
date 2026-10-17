import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPreview, RelatedTaskList, statusActions } from "../src/web/components/TaskDetail.js";

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

test("artifact cards render responsive media controls and safe missing placeholders", () => {
  const video = renderToStaticMarkup(React.createElement(ArtifactPreview, { artifact: {
    source: "demo.mp4", sourceType: "path", filename: "demo.mp4", mediaType: "video/mp4", size: 2048,
    previewKind: "video", availability: "available", previewUrl: "/api/artifact/1",
  } }));
  assert.match(video, /Preview/);
  assert.doesNotMatch(video, /<video/);
  assert.match(video, /2.0 KB/);
  const missing = renderToStaticMarkup(React.createElement(ArtifactPreview, { artifact: {
    source: "gone.pdf", sourceType: "path", filename: "gone.pdf", mediaType: "application\/pdf", size: null,
    previewKind: "none", availability: "missing", previewUrl: null,
  } }));
  assert.match(missing, /no longer available/);
  assert.doesNotMatch(missing, /href=/);
});
