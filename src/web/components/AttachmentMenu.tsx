import { Image, Paperclip } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import "../attachment-menu.css";

export function AttachmentMenu({ disabled, onFiles, qahwaId }: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  qahwaId?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) { setOpen(false); return; }
    const element = menu.current!;
    // The top layer keeps the menu clear of scrolling composers and dialogs.
    element.showPopover?.();
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + 8, Math.min(anchor.left, left + width - rect.width - 8))}px`;
      const preferredTop = anchor.top - rect.height - 8 >= top + 8 ? anchor.top - rect.height - 8 : anchor.bottom + 8;
      element.style.top = `${Math.max(top + 8, Math.min(preferredTop, top + height - rect.height - 8))}px`;
    };
    position();
    const frame = requestAnimationFrame(position);
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!element.contains(target) && !trigger.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [open, disabled]);

  const choose = (input: HTMLInputElement | null) => {
    close(true);
    if (!input || disabled) return;
    input.value = "";
    // Keep the native picker in the option's activation gesture.
    input.click();
  };

  return <>
    <button ref={trigger} className="attach-button" type="button" data-qahwa-id={qahwaId} disabled={disabled} aria-label="Add files" title="Add files" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
    }}><Paperclip aria-hidden="true" /></button>
    <input ref={photos} className="attachment-input" type="file" multiple accept="image/*" aria-label="Choose photos" tabIndex={-1} aria-hidden="true" onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
    <input ref={files} className="attachment-input" type="file" multiple aria-label="Add files" tabIndex={-1} aria-hidden="true" onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
    {open && <div ref={menu} id={id} className="attachment-menu" popover="manual" role="menu" aria-label="Add attachment" onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === "Tab") close(true);
    }}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(photos.current)}><Image aria-hidden="true" /><span>Photos</span></button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(files.current)}><Paperclip aria-hidden="true" /><span>Files</span></button>
    </div>}
  </>;
}
