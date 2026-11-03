import { Bot, ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Level = 0 | 1 | 2;

// Match Qahwa Design's moveChat/releaseChat: a tap opens half-height,
// an upward pull expands, and downward pulls step back toward closed.
export function DesignChatSheet({ enabled, taskId, connected, pending, onOpenChange, children }: {
  enabled: boolean;
  taskId?: string;
  connected: boolean;
  pending: number;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [level, setLevel] = useState<Level>(0);
  const drag = useRef<{ y: number; level: Level } | null>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useLayoutEffect(() => onOpenChange(level > 0), [level, onOpenChange]);
  useEffect(() => { setLevel(0); drag.current = null; }, [taskId, enabled]);
  useEffect(() => { if (enabled && pending > 0) setLevel(current => current === 0 ? 1 : current); }, [enabled, pending]);
  const toggle = () => setLevel(current => current === 0 ? 1 : current === 1 ? 2 : 1);
  const close = () => { setLevel(0); tabRef.current?.focus({ preventScroll: true }); };

  return <section className={enabled ? `design-chat-sheet level-${level}` : "workspace-chat"} aria-label={enabled ? "Canvas chat" : undefined} onKeyDown={event => {
    if (enabled && level > 0 && event.key === "Escape") { event.stopPropagation(); close(); }
  }}>
    {enabled && <button ref={tabRef} type="button" className="design-chat-pull-tab" aria-label="Chat panel" aria-expanded={level > 0} aria-controls={panelId}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { y: event.clientY, level };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={event => {
        const start = drag.current;
        drag.current = null;
        if (!start) return;
        const distance = event.clientY - start.y;
        if (distance < -34) setLevel(2);
        else if (distance > 34) setLevel(start.level === 2 ? 1 : 0);
        else toggle();
      }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onClick={event => { if (event.detail === 0) toggle(); }}
      onKeyDown={event => {
        if (event.key === "ArrowUp") { event.preventDefault(); setLevel(2); }
        else if (event.key === "ArrowDown") { event.preventDefault(); setLevel(current => current === 2 ? 1 : 0); }
      }}>
      <span aria-hidden="true" />Chat{level === 2 ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
    </button>}
    <div id={panelId} className="design-chat-body" hidden={enabled && level === 0}>
      {enabled && <header className="design-chat-heading">
        <span className="design-chat-orb" aria-hidden="true"><Bot /></span>
        <div><strong>Task chat</strong><small>{connected ? "Session connected" : "Reconnecting…"}</small></div>
        <button type="button" aria-label={level === 2 ? "Reduce chat" : "Expand chat"} onClick={() => setLevel(current => current === 2 ? 1 : 2)}>{level === 2 ? <ChevronDown /> : <ChevronUp />}</button>
        <button type="button" aria-label="Close chat" onClick={close}><X /></button>
      </header>}
      {children}
    </div>
  </section>;
}
