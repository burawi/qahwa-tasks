import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectLogo } from "../src/web/components/ProjectLogo.js";
import { projectLogoValidationError } from "../src/web/project-logo.js";

test("project logo UI uses a deterministic prefix fallback", () => {
  const fallback = renderToStaticMarkup(createElement(ProjectLogo, { logo: null, prefix: "QAH", size: "large" }));
  assert.match(fallback, />QAH</);
  const pairedAssetPlaceholder = renderToStaticMarkup(createElement(ProjectLogo, {
    logo: { mimeType: "image/png", size: 68, updatedAt: "2026-10-17T12:00:00.000Z", url: "/api/projects/one/logo?v=1" },
    prefix: "QAH", size: "small",
  }));
  assert.doesNotMatch(pairedAssetPlaceholder, /src="\/api\//);
  assert.match(pairedAssetPlaceholder, />Q</);
});

test("project logo UI rejects unsupported, empty, and oversized files", () => {
  assert.equal(projectLogoValidationError({ type: "image/gif", size: 100 }), "Choose a PNG, JPEG, or WebP image");
  assert.equal(projectLogoValidationError({ type: "image/png", size: 0 }), "Logo file is empty");
  assert.equal(projectLogoValidationError({ type: "image/webp", size: 2 * 1024 * 1024 + 1 }), "Logo must be 2 MB or smaller");
  assert.equal(projectLogoValidationError({ type: "image/jpeg", size: 1024 }), null);
});

test("project logo UI accepts files above 256 KB through exactly 2 MiB", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    for (const size of [256 * 1024 + 1, 512 * 1024 + 1, 2 * 1024 * 1024]) {
      assert.equal(projectLogoValidationError({ type, size }), null);
    }
  }
});
