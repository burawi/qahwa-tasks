import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatExcerpt, ChatMessage } from "../../domain/types";
import { BlockCopyButton } from "./BlockCopyButton";
import "../chat-excerpt.css";

/** Use the browser's native selection so copying and touch handles still work. */
export function ChatExcerptSelection({ stream, messages, disabled, onSelect }: {
  stream: RefObject<HTMLDivElement | null>;
  messages?: ChatMessage[];
  disabled: boolean;
  onSelect: (excerpt: ChatExcerpt) => void;
}) {
  const [candidate, setCandidate] = useState<ChatExcerpt | null>(null);
  const action = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement;
      const start = element(range?.startContainer ?? null)?.closest(".markdown-body");
      const end = element(range?.endContainer ?? null)?.closest(".markdown-body");
      const article = start?.closest<HTMLElement>("[data-chat-message-id]");
      const source = messages?.find(message => message.id === article?.dataset.chatMessageId);
      const excerpt = selection?.toString() ?? "";
      if (!selection?.isCollapsed && start && start === end && stream.current?.contains(start) && source && excerpt.trim()) {
        setCandidate({ messageId: source.id, excerpt, role: source.role });
      } else if (!action.current?.contains(document.activeElement)) setCandidate(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setCandidate(null); window.getSelection()?.removeAllRanges(); }
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", escape);
    };
  }, [messages, stream]);
  if (!candidate || disabled) return null;
  const tooLong = candidate.excerpt.length > 30_000;
  return <div ref={action} className="chat-excerpt-action" aria-label="Selected chat text">
    <span>{tooLong ? "Select at most 30,000 characters" : candidate.excerpt}</span>
    <button type="button" disabled={tooLong} onPointerDown={event => event.preventDefault()} onClick={() => {
      onSelect(candidate);
      setCandidate(null);
      window.getSelection()?.removeAllRanges();
    }}>Comment on selection</button>
  </div>;
}

export function ExcerptPreview({ excerpt }: { excerpt: ChatExcerpt }) {
  return <div className="chat-excerpt-preview">
    <div className="chat-excerpt-heading"><strong>Replying to {excerpt.role === "user" ? "you" : excerpt.role === "system" ? "system info" : "the assistant"}</strong><BlockCopyButton text={excerpt.excerpt} label="Copy reply excerpt" /></div>
    <blockquote>{excerpt.excerpt}</blockquote>
    <button type="button" onClick={() => {
      const source = document.getElementById(`chat-message-${excerpt.messageId}`);
      const disclosure = source?.querySelector("details");
      if (disclosure) disclosure.open = true;
      source?.scrollIntoView({ block: "center" });
      source?.focus({ preventScroll: true });
    }}>View original message</button>
  </div>;
}
