import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPreview, PreviewOutput, RelatedTaskList, statusActions } from "../src/web/components/TaskDetail.js";

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

test("preview output distinguishes local review from production and hides stopped links", () => {
  const available = renderToStaticMarkup(React.createElement(PreviewOutput, { preview: {
    url: "https://workstation.tailnet.ts.net:4173/", startCommand: "npm run preview -- --host 0.0.0.0",
    processOwner: "Codex session 123", availability: "available", checkedAt: "2026-10-17T09:00:00.000Z",
  } }));
  assert.match(available, /Open preview/);
  assert.match(available, /not a production deployment/);
  assert.match(available, /href="https:\/\/workstation.tailnet.ts.net:4173\/"/);

  const stopped = renderToStaticMarkup(React.createElement(PreviewOutput, { preview: {
    url: "http://100.64.0.10:4173/", startCommand: "npm run dev:web -- --host 0.0.0.0",
    processOwner: "Codex session 123", availability: "stopped", checkedAt: "2026-10-17T09:00:00.000Z",
  } }));
  assert.match(stopped, /Preview unavailable/);
  assert.match(stopped, /Stopped/);
  assert.doesNotMatch(stopped, /href=/);
});
