import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");
function fixture(initial: string | null = null, dark = false, blocked = false) {
  const events = new EventTarget(), mediaEvents = new EventTarget();
  const storage = new Map(initial === null ? [] : [["qahwa-theme", initial]]);
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const metas = [0, 1].map(() => ({ content: "", media: "system", removeAttribute() { this.media = ""; } }));
  const media = { matches: dark, addEventListener: mediaEvents.addEventListener.bind(mediaEvents) };
  const window = Object.assign(events, { matchMedia: () => media, __QAHWA_THEME__: null as null | { set: (value: string) => boolean } });
  const localStorage = {
    getItem: (key: string) => { if (blocked) throw new Error("blocked"); return storage.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (blocked) throw new Error("blocked"); storage.set(key, value); },
  };
  runInNewContext(source, { window, localStorage, document: { documentElement: root, querySelectorAll: () => metas }, Event });
  return { root, metas, storage, set: (value: string) => window.__QAHWA_THEME__!.set(value),
    system: (value: boolean) => { media.matches = value; mediaEvents.dispatchEvent(new Event("change")); },
    storageChange: (key: string | null = "qahwa-theme") => window.dispatchEvent(Object.assign(new Event("storage"), { key })),
  };
}

test("default System tracks device appearance and native browser chrome", () => {
  const f = fixture();
  assert.equal(f.root.dataset.themePreference, "system");
  assert.equal(f.root.dataset.theme, "light");
  f.system(true);
  assert.equal(f.root.dataset.theme, "dark");
  assert.equal(f.root.style.colorScheme, "dark");
  assert.ok(f.metas.every(meta => meta.content === "#14101e" && meta.media === ""));
  f.system(false);
  assert.ok(f.metas.every(meta => meta.content === "#f7f5fc"));
});

test("saved manual themes override system on startup and later changes", () => {
  for (const theme of ["light", "dark"]) {
    const f = fixture(theme, theme === "light");
    assert.equal(f.root.dataset.theme, theme);
    f.system(false); f.system(true);
    assert.equal(f.root.dataset.theme, theme);
    assert.equal(f.root.dataset.themePreference, theme);
  }
});

test("switching persists only the device theme key and System resumes tracking", () => {
  const f = fixture(null, true);
  assert.equal(f.set("light"), true);
  assert.deepEqual([...f.storage], [["qahwa-theme", "light"]]);
  assert.equal(f.root.dataset.theme, "light");
  f.set("dark"); assert.equal(f.root.dataset.theme, "dark");
  f.set("system"); f.system(false);
  assert.equal(f.root.dataset.theme, "light");
  assert.equal(f.root.dataset.themePreference, "system");
});

test("other tabs and cleared storage update an open page", () => {
  const f = fixture("dark", false);
  f.storage.set("qahwa-theme", "light"); f.storageChange();
  assert.equal(f.root.dataset.theme, "light");
  f.storage.set("qahwa-theme", "dark"); f.storageChange("unrelated");
  assert.equal(f.root.dataset.theme, "light");
  f.storageChange(); assert.equal(f.root.dataset.theme, "dark");
  f.storage.clear(); f.storageChange(null);
  assert.equal(f.root.dataset.themePreference, "system");
  assert.equal(f.root.dataset.theme, "light");
});

test("invalid or inaccessible storage safely falls back to System", () => {
  assert.equal(fixture("invalid", true).root.dataset.theme, "dark");
  const f = fixture(null, true, true);
  assert.equal(f.root.dataset.themePreference, "system");
  assert.equal(f.set("light"), false);
  assert.equal(f.root.dataset.theme, "light");
  f.system(true); assert.equal(f.root.dataset.theme, "light");
});
