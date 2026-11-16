import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");

test("completed tasks stay out of the primary task list behind a quiet history control", () => {
  assert.match(app, /useState<Scope>\("active"\)/);
  assert.doesNotMatch(app, /\["all", "active", "closed"\]/);
  assert.match(app, /Completed task history/);
  assert.match(app, /scope === "closed" \? "active" : "closed"/);
});
