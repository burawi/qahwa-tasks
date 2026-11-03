import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatReadState, SessionRunState } from "../domain/types";

interface ReadSource {
  load: () => Promise<{ readState: ChatReadState; sessionState?: SessionRunState }>;
  acknowledge: (messageIds: string[]) => Promise<{ readState: ChatReadState }>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** Shared server receipts, with highlights retained only for this local visit. */
export function useChatReadState(source: ReadSource, connected: boolean, open: boolean, visible: boolean) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [sessionState, setSessionState] = useState<SessionRunState>();
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const renderedIds = useRef<ReadonlySet<string>>(EMPTY_IDS);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) {
      renderedIds.current = EMPTY_IDS;
      setHighlightedIds(EMPTY_IDS);
    }
  }, [open]);

  const onMessagesLoaded = useCallback((messages: ChatMessage[]) => {
    renderedIds.current = new Set(messages.filter((message) => message.role === "assistant").map((message) => message.id));
    refreshRef.current?.();
  }, []);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let running = false;
    let rerun = false;
    let timer: number | undefined;
    const canRead = () => !stopped && open && visible
      && document.visibilityState === "visible" && document.hasFocus();
    const refresh = async () => {
      if (stopped) return;
      if (running) { rerun = true; return; }
      running = true;
      window.clearTimeout(timer);
      try {
        let { readState, sessionState } = await source.load();
        if (stopped) return;
        setSessionState(sessionState);
        setUnreadCount(readState.unreadCount);
        // A summary may arrive before the history. Acknowledge only messages
        // already rendered, never the unseen tail of a concurrent reply.
        while (canRead()) {
          const ids = readState.unreadMessageIds.filter((id) => renderedIds.current.has(id)).slice(0, 1000);
          if (!ids.length) break;
          setHighlightedIds((current) => ids.every((id) => current.has(id)) ? current : new Set([...current, ...ids]));
          ({ readState } = await source.acknowledge(ids));
          if (stopped) return;
          setUnreadCount(readState.unreadCount);
        }
      } catch {
        if (!stopped) setSessionState(undefined);
        // Keep the badge and retry after reconnect or the next poll. Failed
        // acknowledgements must not optimistically discard unread messages.
      } finally {
        running = false;
        if (!stopped) {
          if (rerun) { rerun = false; void refresh(); }
          else timer = window.setTimeout(() => void refresh(), 1500);
        }
      }
    };
    const requestRefresh = () => { void refresh(); };
    refreshRef.current = requestRefresh;
    window.addEventListener("focus", requestRefresh);
    document.addEventListener("visibilitychange", requestRefresh);
    requestRefresh();
    return () => {
      stopped = true;
      refreshRef.current = null;
      window.clearTimeout(timer);
      window.removeEventListener("focus", requestRefresh);
      document.removeEventListener("visibilitychange", requestRefresh);
    };
  }, [source, connected, open, visible]);

  return { unreadCount, sessionState: connected ? sessionState : undefined, highlightedIds: open ? highlightedIds : EMPTY_IDS, onMessagesLoaded };
}
