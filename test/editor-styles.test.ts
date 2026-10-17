import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");

test("focused rich-text editors use an explicit theme-aware caret color", () => {
  assert.match(styles, /:root\s*{[^}]*--caret:\s*#914421;/s);
  assert.match(styles, /prefers-color-scheme:\s*dark[\s\S]*?:root\s*{[^}]*--caret:\s*#f49a65;/);
  assert.match(styles, /\.rich-input:focus\s*{\s*caret-color:\s*var\(--caret\);\s*}/);
});

test("artifact previews stay within the viewport and wrap actions on narrow screens", () => {
  assert.match(styles, /\.artifact-preview\s*{[^}]*width:\s*100%;[^}]*max-height:\s*min\(62dvh, 520px\);/s);
  assert.match(styles, /\.artifact-actions\s*{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(styles, /\.artifact-card\s*{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
});
