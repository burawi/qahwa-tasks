import assert from "node:assert/strict";
import test from "node:test";
import { attachmentResource, messageResource, previewKind, taskIdFromPath } from "../src/web/message-resource.js";
import type { TaskArtifact } from "../src/domain/types.js";

test("task URLs accept normal IDs and reject malformed escapes without crashing", () => {
  assert.equal(taskIdFromPath("/tasks/QAH-0025"), "QAH-0025");
  assert.equal(taskIdFromPath("/tasks/%51AH-0025"), "QAH-0025");
  assert.equal(taskIdFromPath("/tasks/90c78dd9-dac3-481d-b69e-07971c86acaf"), "90c78dd9-dac3-481d-b69e-07971c86acaf");
  for (const pathname of ["/tasks/%", "/tasks/%E0%A4%A", "/tasks/%2Fetc", "/tasks/%00", "/tasks/%25", "/tasks/a/b", "/orchestrator"]) assert.equal(taskIdFromPath(pathname), null);
});

test("message resources reject unsafe or malformed navigation without throwing", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "blob:https://example.com/id", "https://%", "http://[", "/home/private.png", "file:///etc/passwd", "//evil.invalid/p.png", "/unknown/path", "https://user:password@example.com"]) {
    assert.equal(messageResource(url).url, null, url);
  }
  assert.equal(messageResource("https://example.com/page?q=1#section").url, "https://example.com/page?q=1#section");
  assert.equal(messageResource("mailto:hello@example.com").url, "mailto:hello@example.com");
  assert.equal(messageResource("tel:+21612345678").url, "tel:+21612345678");
  assert.equal(messageResource("/tasks/QAH-0025").url, "/tasks/QAH-0025");
  assert.equal(messageResource("/orchestrator").url, "/orchestrator");
});

test("authorized local artifacts resolve to the existing scoped serving route", () => {
  const artifact: TaskArtifact = { source: "images/a b.png", sourceType: "path", filename: "a b.png", mediaType: "image/png", size: 512, previewKind: "image", availability: "available", previewUrl: "/api/tasks/task/outputs/out/artifacts/0" };
  for (const source of ["images/a%20b.png", "/project/images/a b.png", "file:///project/images/a b.png"]) {
    const resolved = messageResource(source, [artifact], "/project");
    assert.equal(resolved.url, artifact.previewUrl);
    assert.equal(resolved.protected, true);
    assert.equal(resolved.kind, "image");
  }
  assert.equal(messageResource("/outside/a b.png", [artifact], "/project").url, null);
  assert.equal(messageResource(artifact.source, [{ ...artifact, previewUrl: null, availability: "missing" }], "/project").unavailable, "File unavailable or outside the project");
  assert.equal(messageResource(artifact.previewUrl!).protected, true);
});

test("uploads and public URLs identify supported media and expired-file fallback", () => {
  for (const [filename, kind] of [["a.png?q=1", "image"], ["clip.webm", "video"], ["song.MP3", "audio"], ["recording.m4a", "audio"], ["report.pdf", "pdf"], ["notes.txt", "text"], ["archive.zip", "none"]]) {
    assert.equal(previewKind("", filename), kind);
  }
  assert.equal(previewKind("audio/webm;codecs=opus", "recording"), "audio");
  const expired = attachmentResource({ id: "old", previewUrl: "/api/orchestrator/attachments/old", filename: "old.wav", mediaType: "audio/wav", size: 1, status: "expired" });
  assert.equal(expired.unavailable, "File expired");
  assert.equal(expired.kind, "audio");
});

test("message-scoped registrations resolve legacy aliases and protected routes without exposing host paths", () => {
  for (const prefix of ["/api/tasks/task", "/api/orchestrator"]) {
    const url = `${prefix}/files/file-id`;
    for (const source of ["/project/report.txt", "file:///project/report.txt", "sandbox:/project/report.txt"]) {
      const file: TaskArtifact = { source, sourceType: "path", filename: "report.txt", mediaType: "text/plain", size: 20, previewKind: "text", availability: "available", previewUrl: url };
      assert.deepEqual(messageResource(source, [file]), { url, filename: "report.txt", protected: true, size: 20, mediaType: "text/plain", kind: "text", unavailable: undefined });
      assert.equal(messageResource(source, [{ ...file, previewUrl: null, availability: "missing" }]).url, null);
    }
    assert.equal(messageResource(url).protected, true);
  }
  assert.equal(messageResource("sandbox:/project/unregistered.pdf").url, null);
});
