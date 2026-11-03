import { BellOff, BellRing, Check, MoreHorizontal, Pause, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import "../task-actions-menu.css";

export function TaskActionsMenu({ running, disabled, closed = false, notificationsEnabled, onToggleNotifications, onPause, onCancel, onComplete }: {
  running: boolean;
  closed?: boolean;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  disabled: boolean;
  onPause: () => void;
  onCancel: () => void;
  onComplete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const lastItem = useRef(false);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) { close(); return; }
    const element = menu.current!;
    // Use the top layer so the canvas and scrolling chat cannot clip the menu.
    element.showPopover?.();
    const items = element.querySelectorAll<HTMLButtonElement>("button");
    (lastItem.current ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + 8, Math.min(anchor.right - rect.width, left + width - rect.width - 8))}px`;
      const preferred = anchor.bottom + 6 + rect.height <= top + height - 8 ? anchor.bottom + 6 : anchor.top - rect.height - 6;
      element.style.top = `${Math.max(top + 8, Math.min(preferred, top + height - rect.height - 8))}px`;
    };
    position();
    const outside = (event: Event) => {
      if (!element.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [open, disabled, running]);

  const choose = (action: () => void, requiresPause = false) => {
    if (disabled || (requiresPause && running)) return;
    close(true);
    action();
  };
  return <>
    <button ref={trigger} type="button" className="icon-button task-actions-trigger" disabled={disabled}
      aria-label="Task actions" title="Task actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { lastItem.current = false; setOpen(value => !value); }} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); lastItem.current = event.key === "ArrowUp"; setOpen(true);
        }
      }}><MoreHorizontal aria-hidden="true" /></button>
    {open && <div ref={menu} id={id} className="task-actions-menu" popover="manual" role="menu" aria-label="Task actions" onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === "Tab") close(true);
    }}>
      {!closed && <>
      {running && <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(onPause)}><Pause aria-hidden="true" /><span>Pause</span></button>}
      <button type="button" role="menuitem" tabIndex={-1} className="task-action-cancel" aria-disabled={running} aria-describedby={running ? `${id}-hint` : undefined}
        onClick={() => choose(onCancel, true)}><X aria-hidden="true" /><span>Cancel</span></button>
      <button type="button" role="menuitem" tabIndex={-1} aria-disabled={running} aria-describedby={running ? `${id}-hint` : undefined}
        onClick={() => choose(onComplete, true)}><Check aria-hidden="true" /><span>Complete</span></button>
      {running && <p id={`${id}-hint`} role="note">Pause before cancelling or completing.</p>}
      </>}
      <button type="button" role="menuitemcheckbox" tabIndex={-1} className="task-action-notifications" aria-label="Notify when task is idle" aria-checked={notificationsEnabled}
        onClick={() => choose(onToggleNotifications)}>
        {notificationsEnabled ? <BellRing aria-hidden="true" /> : <BellOff aria-hidden="true" />}<span>Idle notifications</span><small aria-hidden="true">{notificationsEnabled ? "On" : "Off"}</small>
      </button>
    </div>}
  </>;
}
