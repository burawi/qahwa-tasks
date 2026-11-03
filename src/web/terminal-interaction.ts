import type { Terminal } from "@xterm/xterm";

/** Scroll history with a finger; fullscreen apps receive wheel gestures instead. */
export function attachTerminalTouchScrolling(host: HTMLElement, terminal: Terminal): () => void {
  let gesture: { x: number; y: number; lastY: number; scrolling: boolean; remainder: number } | undefined;
  const start = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    gesture = touch ? { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, scrolling: false, remainder: 0 } : undefined;
  };
  const move = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    if (!gesture || !touch) { gesture = undefined; return; }
    if (!gesture.scrolling) {
      const dy = Math.abs(touch.clientY - gesture.y), dx = Math.abs(touch.clientX - gesture.x);
      if (dy < 8 || dy <= dx) return;
      gesture.scrolling = true;
    }
    event.preventDefault();
    const deltaY = gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    if (terminal.buffer.active.type === "normal" && terminal.modes.mouseTrackingMode === "none") {
      const screen = host.querySelector(".xterm-screen");
      const cellHeight = (screen?.getBoundingClientRect().height ?? 0) / terminal.rows || 15;
      gesture.remainder += deltaY;
      const lines = Math.trunc(gesture.remainder / cellHeight);
      if (lines) {
        terminal.scrollLines(lines);
        gesture.remainder -= lines * cellHeight;
      }
      return;
    }
    host.querySelector(".xterm-screen")?.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY, clientX: touch.clientX, clientY: touch.clientY,
    }));
  };
  const end = () => { gesture = undefined; };
  host.addEventListener("touchstart", start, { passive: true });
  host.addEventListener("touchmove", move, { passive: false });
  host.addEventListener("touchend", end);
  host.addEventListener("touchcancel", end);
  return () => {
    host.removeEventListener("touchstart", start);
    host.removeEventListener("touchmove", move);
    host.removeEventListener("touchend", end);
    host.removeEventListener("touchcancel", end);
  };
}

/** Plain text uses logical lines, without inserting breaks at terminal wrapping. */
export function terminalText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const parts: string[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row && !line.isWrapped) parts.push("\n");
    parts.push(line.translateToString(!buffer.getLine(row + 1)?.isWrapped));
  }
  return parts.join("").trimEnd();
}
