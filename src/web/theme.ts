import { useSyncExternalStore } from "react";
import type { ITheme } from "@xterm/xterm";

export type ThemePreference = "system" | "light" | "dark";
declare global {
  interface Window { __QAHWA_THEME__?: { set: (value: ThemePreference) => boolean } }
}

const subscribe = (listener: () => void) => {
  window.addEventListener("qahwa-theme-change", listener);
  return () => window.removeEventListener("qahwa-theme-change", listener);
};
export function useTheme() {
  const resolved = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const preference = useSyncExternalStore(subscribe, () => (document.documentElement.dataset.themePreference ?? "system") as ThemePreference);
  return { resolved, preference, setPreference: (value: ThemePreference) => window.__QAHWA_THEME__?.set(value) ?? false };
}

// Read the same tokens used by the terminal shell without recreating its session.
export function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token("--terminal-bg"), foreground: token("--terminal-text"),
    cursor: token("--terminal-cursor"), cursorAccent: token("--terminal-bg"),
    selectionBackground: token("--terminal-selection"), selectionForeground: token("--terminal-text"),
    black: token("--terminal-black"), brightBlack: token("--muted"),
    red: token("--red"), brightRed: token("--red"), green: token("--green"), brightGreen: token("--green"),
    yellow: token("--yellow"), brightYellow: token("--yellow"), blue: token("--blue"), brightBlue: token("--blue"),
    magenta: token("--accent"), brightMagenta: token("--accent-strong"), cyan: token("--terminal-cyan"), brightCyan: token("--terminal-cyan"),
    white: token("--terminal-white"), brightWhite: token("--terminal-text"),
  };
}
