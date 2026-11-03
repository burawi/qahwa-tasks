import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspace = readFileSync(new URL("../src/web/components/SessionWorkspace.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/web/api.ts", import.meta.url), "utf8");

test("task and orchestrator chats share a composer where Enter inserts a newline", () => {
  assert.match(app, /<SessionWorkspace mode="orchestrator"/);
  assert.match(app, /<TaskChat /);
  const taskChat = readFileSync(new URL("../src/web/components/TaskChat.tsx", import.meta.url), "utf8");
  assert.match(taskChat, /<SessionWorkspace mode="task"/);
  assert.match(workspace, /<textarea aria-label="Message"/);
  assert.doesNotMatch(workspace, /requestSubmit\(\)/);
  assert.doesNotMatch(workspace, /event\.key === "Enter"/);
});

test("chat messages remain explicitly sendable with the Send button", () => {
  assert.match(workspace, /<form className=\{`chat-composer/);
  assert.match(workspace, /<button className="send-button" type="submit"/);
  assert.match(workspace, /aria-label="Send"><Send \/><\/button>/);
});

test("a reconnecting request cannot lock typing in the composer", () => {
  assert.match(workspace, /<textarea aria-label="Message" inputMode="text"/);
  assert.doesNotMatch(workspace, /<textarea aria-label="Message"[^>]*disabled=/);
  assert.match(workspace, /setMessage\(\(current\) => current === message \? "" : current\)/);
  assert.match(api, /this\.rejectPending\("Connection replaced while reconnecting"\)/);
  assert.match(api, /window\.clearTimeout\(pending\.timer\)/);
});

test("shared composer supports mobile multi-file selection, desktop drops, progress, and attachment-only sends", () => {
  const attachmentMenu = readFileSync(new URL("../src/web/components/AttachmentMenu.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<AttachmentMenu /);
  assert.match(attachmentMenu, /type="file" multiple aria-label="Add files"/);
  assert.match(workspace, /onDrop=\{\(event\)/);
  assert.match(workspace, /Uploading \$\{item\.progress\}%/);
  assert.match(workspace, /attachmentIds/);
  assert.match(workspace, /!message\.trim\(\) && !attachments\.some/);
  assert.match(workspace, /MAX_ATTACHMENT_BYTES = 100 \* 1024 \* 1024/);
  assert.match(workspace, /MAX_MESSAGE_ATTACHMENT_BYTES = 250 \* 1024 \* 1024/);
});

test("chat history renders image previews, downloads, and an explicit expired-file state", () => {
  const renderer = readFileSync(new URL("../src/web/components/MessageBody.tsx", import.meta.url), "utf8");
  const resources = readFileSync(new URL("../src/web/message-resource.ts", import.meta.url), "utf8");
  assert.match(workspace, /MessageBody/);
  assert.match(renderer, /entry\.metadata\?\.attachments/);
  assert.match(renderer, /fetchMessageFile/);
  assert.match(resources, /File expired/);
  assert.match(resources, /attachment\.status === "expired"/);
});
