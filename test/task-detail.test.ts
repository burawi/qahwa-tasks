import assert from "node:assert/strict";
import test from "node:test";
import { statusActions } from "../src/web/components/TaskDetail.js";

test("in-review task actions omit Request changes and retain Mark completed", () => {
  assert.deepEqual(statusActions("in_review"), [
    { label: "Mark completed", to: "closed", outcome: "completed", kind: "primary" },
  ]);
});
