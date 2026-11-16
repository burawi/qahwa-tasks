import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../src/web/components/TaskCard.tsx", import.meta.url), "utf8");
const session = readFileSync(new URL("../src/web/components/SessionWorkspace.tsx", import.meta.url), "utf8");
const workflowStyles = readFileSync(new URL("../src/web/chat-model.css", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
const activityStyles = readFileSync(new URL("../src/web/running-indicator.css", import.meta.url), "utf8");

test("completed tasks stay out of the primary task list behind a quiet history control", () => {
  assert.match(app, /useState<Scope>\("active"\)/);
  assert.doesNotMatch(app, /\["all", "active", "closed"\]/);
  assert.match(app, /Completed task history/);
  assert.match(app, /scope === "closed" \? "active" : "closed"/);
});

test("task cards and task chat show the overall workflow owner and concrete next action", () => {
  assert.match(card, /task\.workflow\?\.label/);
  assert.match(card, /task\.workflow\.owner/);
  assert.match(card, /task\.workflow\.nextAction/);
  assert.match(session, /task\.workflow\?\.label/);
  assert.match(session, /session-workflow-next/);
  assert.match(session, /task\.workflow\.nextAction/);
});

test("active specialist ownership is accessible, responsive, and motion-safe on cards and task chat", () => {
  for (const source of [card, session]) {
    assert.match(source, /task\.workflow\.ownerActive/);
    assert.match(source, /is actively preparing review feedback/);
    assert.match(source, /<RunningIndicator running/);
  }
  assert.match(workflowStyles, /\.workflow-owner/);
  assert.match(workflowStyles, /@media \(max-width: 420px\)/);
  assert.match(workflowStyles, /text-overflow: ellipsis/);
  assert.match(activityStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(activityStyles, /animation: none/);
});

test("task chat gives review workflow sole activity ownership with legible mobile and desktop text", () => {
  assert.match(session, /workflowOwnsActivity/);
  assert.match(session, /task\.workflow\.state === "reviewing"/);
  assert.match(session, /task\.workflow\.state === "capacity_queued"/);
  assert.match(session, /workspace && !workflowOwnsActivity/);
  assert.match(workflowStyles, /session-workflow-next[^}]*font-size: 11px/);
  assert.match(workflowStyles, /session-workflow-next[^}]*white-space: normal/);
  assert.match(workflowStyles, /@media \(min-width: 700px\)[\s\S]*session-workflow-next[^}]*font-size: 12px/);
  assert.match(appStyles, /\.workflow-remark\s*\{[^}]*font-size: 11px/);
  assert.match(appStyles, /@media \(min-width: 700px\)[\s\S]*\.workflow-remark\s*\{[^}]*font-size: 12px/);
});
