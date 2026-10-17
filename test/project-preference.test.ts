import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "../src/domain/types.js";
import {
  LAST_CREATE_PROJECT_KEY,
  preferredCreateProjectId,
  readLastCreateProjectId,
  writeLastCreateProjectId,
} from "../src/web/project-preference.js";

const projects = [{ id: "first" }, { id: "second" }] as Project[];

test("prefers the last project selected in task creation", () => {
  assert.equal(preferredCreateProjectId(projects, "second", "first"), "second");
});

test("falls back when the saved project is unavailable", () => {
  assert.equal(preferredCreateProjectId(projects, "archived", "second"), "second");
  assert.equal(preferredCreateProjectId(projects, "missing"), "first");
  assert.equal(preferredCreateProjectId([], "missing"), "");
});

test("persists and clears the task creation preference", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  writeLastCreateProjectId("second", storage);
  assert.equal(values.get(LAST_CREATE_PROJECT_KEY), "second");
  assert.equal(readLastCreateProjectId(storage), "second");
  writeLastCreateProjectId(undefined, storage);
  assert.equal(readLastCreateProjectId(storage), undefined);
});

test("ignores unavailable browser storage", () => {
  const storage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.equal(readLastCreateProjectId(storage), undefined);
  assert.doesNotThrow(() => writeLastCreateProjectId("first", storage));
});
