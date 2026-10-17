import assert from "node:assert/strict";
import test from "node:test";
import { projectHue } from "../src/web/project-color.js";

test("project hue is stable and stays in the CSS hue range", () => {
  const first = projectHue("project-123");
  assert.equal(projectHue("project-123"), first);
  assert.ok(first >= 0 && first < 360);
});

test("project hue distinguishes representative project identifiers", () => {
  const hues = ["qahwa-tasks", "wassala", "majenna", "muhasib"].map(projectHue);
  assert.equal(new Set(hues).size, hues.length);
});
