import type { TaskWorkspace } from "../domain/types";

// The host hit-tests in artboard pixels. Scripts stay disabled in the sandbox,
// so selection also works under the app's script-src 'self' security policy.
export function canvasSource(document: NonNullable<TaskWorkspace["design"]>["document"]) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:${document.artboard.background}}${document.css}\n[data-qahwa-selected]{outline:3px solid #2563eb!important;outline-offset:2px}</style></head><body>${document.html}</body></html>`;
}
