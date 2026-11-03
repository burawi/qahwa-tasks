import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const MIN_ZOOM = .05;
const MAX_ZOOM = 1.5;
const GUTTER = 24;
type Point = { x: number; y: number };
type Anchor = Point & { localX: number; localY: number };
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

export function useCanvasViewport(width: number, height: number, fullscreen: boolean, onTap: (x: number, y: number) => void, onLongPress?: (x: number, y: number) => void, gestureKey?: string) {
  const stageRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(.75);
  const zoomRef = useRef(zoom);
  const fitting = useRef(true);
  const pending = useRef<Anchor | "center" | null>(null);
  const tapRef = useRef(onTap);
  tapRef.current = onTap;
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;

  const position = useCallback(() => {
    const stage = stageRef.current, board = artboardRef.current, anchor = pending.current;
    if (!stage || !board || !anchor) return;
    pending.current = null;
    if (anchor === "center") {
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
    } else {
      const viewport = stage.getBoundingClientRect(), rect = board.getBoundingClientRect();
      stage.scrollLeft += rect.left - viewport.left + anchor.x * zoomRef.current - anchor.localX;
      stage.scrollTop += rect.top - viewport.top + anchor.y * zoomRef.current - anchor.localY;
    }
  }, []);
  useLayoutEffect(position, [zoom, position]);

  const zoomTo = useCallback((value: number, point?: Point, center = false) => {
    const stage = stageRef.current, board = artboardRef.current;
    if (!stage || !board) return;
    // Very tall valid artboards must still fit in the embedded viewport.
    const minimum = Math.max(.001, Math.min(MIN_ZOOM, Math.max(1, stage.clientWidth - GUTTER * 2) / width, Math.max(1, stage.clientHeight - GUTTER * 2) / height));
    const next = Math.min(MAX_ZOOM, Math.max(minimum, value));
    if (!Number.isFinite(next)) return;
    const viewport = stage.getBoundingClientRect(), rect = board.getBoundingClientRect();
    const x = point?.x ?? viewport.left + stage.clientWidth / 2;
    const y = point?.y ?? viewport.top + stage.clientHeight / 2;
    pending.current = center ? "center" : { x: (x - rect.left) / zoomRef.current, y: (y - rect.top) / zoomRef.current, localX: x - viewport.left, localY: y - viewport.top };
    fitting.current = center;
    if (next === zoomRef.current) position();
    else { zoomRef.current = next; setZoom(next); }
  }, [position, width, height]);
  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (stage) {
      // Keep the artboard visible when chat or the keyboard leaves a short viewport.
      const horizontalGutter = Math.min(GUTTER * 2, stage.clientWidth / 2);
      const verticalGutter = Math.min(GUTTER * 2, stage.clientHeight / 2);
      zoomTo(Math.min(1, (stage.clientWidth - horizontalGutter) / width, (stage.clientHeight - verticalGutter) / height), undefined, true);
    }
  }, [width, height, zoomTo]);
  useLayoutEffect(() => {
    fitting.current = true;
    fit();
    const observer = new ResizeObserver(() => { if (fitting.current) fit(); });
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [fit, fullscreen]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const pointers = new Map<number, Point>();
    let start: Point | null = null;
    let moved = false;
    let previous: { center: Point; distance: number } | null = null;
    let safariScale = 1;
    let longPressed = false;
    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelLongPress = () => { clearTimeout(longPressTimer); longPressTimer = undefined; };
    const artboardPoint = (point: Point) => {
      const rect = artboardRef.current!.getBoundingClientRect();
      return { x: (point.x - rect.left) / zoomRef.current, y: (point.y - rect.top) / zoomRef.current };
    };
    const snapshot = () => {
      const [a, b] = [...pointers.values()];
      return a ? { center: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a, distance: b ? Math.hypot(b.x - a.x, b.y - a.y) : 0 } : null;
    };
    const down = (event: PointerEvent) => {
      if ((event.target as Element).closest("button")) return; // Comment pins own their taps.
      if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
      const rect = stage.getBoundingClientRect();
      if (event.clientX >= rect.left + stage.clientWidth || event.clientY >= rect.top + stage.clientHeight) return;
      event.preventDefault();
      stage.focus({ preventScroll: true });
      stage.setPointerCapture(event.pointerId);
      cancelLongPress();
      if (!pointers.size) { start = { x: event.clientX, y: event.clientY }; moved = event.button === 1; longPressed = false; }
      else moved = true;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      previous = snapshot();
      stage.classList.add("is-panning");
      if (pointers.size === 1 && !moved && longPressRef.current) {
        longPressTimer = setTimeout(() => {
          if (!start || moved || pointers.size !== 1) return;
          longPressed = true;
          const point = artboardPoint(start);
          longPressRef.current?.(point.x, point.y);
        }, 500);
      }
    };
    const move = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const current = snapshot()!;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) moved = true;
      if (moved) cancelLongPress();
      if (previous && moved) {
        fitting.current = false;
        stage.scrollLeft -= current.center.x - previous.center.x;
        stage.scrollTop -= current.center.y - previous.center.y;
        if (current.distance && previous.distance) zoomTo(zoomRef.current * current.distance / previous.distance, current.center);
      }
      previous = current;
    };
    const end = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      cancelLongPress();
      // Check the release location too: some devices coalesce all move events.
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) moved = true;
      if (event.type === "pointerup" && pointers.size === 1 && !moved && !longPressed) {
        const point = artboardPoint({ x: event.clientX, y: event.clientY });
        tapRef.current(point.x, point.y);
      }
      pointers.delete(event.pointerId);
      previous = snapshot();
      if (!pointers.size) { start = null; stage.classList.remove("is-panning"); }
    };
    const wheel = (event: WheelEvent) => {
      cancelLongPress();
      if (!event.ctrlKey && !event.metaKey) return; // Native two-axis scrolling.
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
      zoomTo(zoomRef.current * Math.exp(-delta * .01), { x: event.clientX, y: event.clientY });
    };
    const gestureStart = (event: Event) => { event.preventDefault(); cancelLongPress(); safariScale = 1; };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEvent;
      // Safari can also emit these during a touch-pointer pinch.
      if (pointers.size > 1) { safariScale = gesture.scale; return; }
      if (gesture.scale > 0) {
        zoomTo(zoomRef.current * gesture.scale / safariScale, { x: gesture.clientX, y: gesture.clientY });
        safariScale = gesture.scale;
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.target !== stage || event.ctrlKey || event.metaKey || event.altKey) return;
      const arrows: Record<string, Point> = { ArrowLeft: { x: -60, y: 0 }, ArrowRight: { x: 60, y: 0 }, ArrowUp: { x: 0, y: -60 }, ArrowDown: { x: 0, y: 60 } };
      if (arrows[event.key]) { event.preventDefault(); stage.scrollBy(arrows[event.key].x, arrows[event.key].y); }
      else if (["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "0") fit(); else zoomTo(zoomRef.current + (event.key === "-" ? -.1 : .1));
      }
    };
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("lostpointercapture", end);
    stage.addEventListener("wheel", wheel, { passive: false });
    stage.addEventListener("gesturestart", gestureStart, { passive: false });
    stage.addEventListener("gesturechange", gestureChange, { passive: false });
    stage.addEventListener("gestureend", gestureStart, { passive: false });
    stage.addEventListener("keydown", key);
    const contextMenu = (event: Event) => { event.preventDefault(); };
    stage.addEventListener("contextmenu", contextMenu);
    return () => {
      cancelLongPress();
      stage.classList.remove("is-panning");
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", end);
      stage.removeEventListener("pointercancel", end);
      stage.removeEventListener("lostpointercapture", end);
      stage.removeEventListener("wheel", wheel);
      stage.removeEventListener("gesturestart", gestureStart);
      stage.removeEventListener("gesturechange", gestureChange);
      stage.removeEventListener("gestureend", gestureStart);
      stage.removeEventListener("keydown", key);
      stage.removeEventListener("contextmenu", contextMenu);
    };
  }, [zoomTo, fit, fullscreen, gestureKey]);
  return { stageRef, artboardRef, zoom, zoomBy: (amount: number) => zoomTo(zoomRef.current + amount), fit };
}
