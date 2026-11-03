// Real app components with isolated in-memory APIs; no production connections.
import "theme-base-fixture";
import { api } from "violet-api";
import { Terminal } from "@xterm/xterm";

const surface = new URLSearchParams(location.search).get("surface");
const controls = window.themeFixture = { terminal: null, opens: 0, inputs: [], artwork: null };
const open = Terminal.prototype.open;
Terminal.prototype.open = function (...args) { controls.terminal = this; controls.opens++; return open.apply(this, args); };
const task = api.task;
api.task = async (...args) => {
  const result = await task(...args);
  if (surface === "terminal") result.task.sessionKind = "terminal";
  return result;
};
api.terminal = async (_id, _generation, cursor) => {
  await new Promise(resolve => setTimeout(resolve, 100));
  return { terminal: { generation: "theme-session", cursor: 1, cols: 80, rows: 24, state: "running", closed: false, messages: [],
    reset: cursor !== 1, data: cursor !== 1 ? "\x1b[32mSaved terminal output\x1b[0m\r\n$ " : "" } };
};
api.resizeTerminal = async () => ({});
api.terminalInput = async (...args) => { controls.inputs.push(args); return {}; };
api.codexUsage = async () => ({ usage: null });
api.uploadAttachment = async (_mode, _taskId, file, progress) => {
  progress(100);
  return { id: `upload-${file.name}`, filename: file.name, size: file.size, mediaType: file.type, status: "available" };
};
const poll = api.workspacePoll;
api.workspacePoll = async (...args) => {
  const result = await poll(...args);
  result.workspace.messages.push({ id: "code", role: "assistant", body: "```js\nconst theme = 'saved';\n```", createdAt: new Date().toISOString(), metadata: null });
  if (surface === "canvas") {
    const document = { format: "web", artboard: { name: "Artwork colors", width: 600, height: 500, background: "#f9debb" },
      html: '<main data-qahwa-id="artwork"><h1 data-qahwa-id="title">Keep artwork colors</h1><p data-qahwa-id="caption">Only the controls follow your theme.</p></main>',
      css: 'body{font:24px system-ui;color:#35221d}main{padding:35px}h1{color:#752b24}p{background:#fff0d2;padding:20px;border-radius:20px}',
    };
    controls.artwork = document;
    Object.assign(result.workspace, { session: { ...result.workspace.session, surface: "design" },
      design: { id: "design", revision: 1, document }, selectedDesignPageId: "artwork",
      designPages: [{ id: "artwork", name: "Artwork colors", revision: 1, document }] });
  }
  return result;
};
