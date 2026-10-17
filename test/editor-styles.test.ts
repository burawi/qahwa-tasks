import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");

test("focused rich-text editors use an explicit theme-aware caret color", () => {
  assert.match(styles, /:root\s*{[^}]*--caret:\s*#914421;/s);
  assert.match(styles, /prefers-color-scheme:\s*dark[\s\S]*?:root\s*{[^}]*--caret:\s*#f49a65;/);
  assert.match(styles, /\.rich-input:focus\s*{\s*caret-color:\s*var\(--caret\);\s*}/);
});
