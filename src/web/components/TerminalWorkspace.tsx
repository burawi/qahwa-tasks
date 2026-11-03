import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Keyboard, RotateCcw, Square, Terminal as TerminalIcon, TextSelect, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TaskDetail, TerminalView } from "../../domain/types";
import { api } from "../api";
import { CodexUsageIndicator } from "./CodexUsageIndicator";
import "@xterm/xterm/css/xterm.css";
import "../terminal.css";
import { useChatReadState } from "../use-chat-read-state";
import { attachTerminalTouchScrolling, terminalText } from "../terminal-interaction";
import { ActionDialog } from "./ActionDialog";
import { terminalTheme, useTheme } from "../theme";

interface Input { id: string; generation: string; data: string; binary: boolean }

function TerminalControlButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const [pressed, setPressed] = useState(false);
  return <button type="button" {...props} data-pressed={pressed || undefined} onPointerDown={event => {
    if (event.button === 0 && !props.disabled) {
      // Keep Android's keyboard open until the click runs. Moving focus to a
      // button can resize the viewport and move it out from under the finger.
      event.preventDefault();
      setPressed(true);
    }
    props.onPointerDown?.(event);
  }} onPointerUp={event => { setPressed(false); props.onPointerUp?.(event); }}
    onPointerCancel={event => { setPressed(false); props.onPointerCancel?.(event); }}
    onPointerLeave={event => { setPressed(false); props.onPointerLeave?.(event); }}
    onLostPointerCapture={event => { setPressed(false); props.onLostPointerCapture?.(event); }} />;
}

export function TerminalWorkspace({ task, connected, foreground, onClose, onChanged, onError }: {
  task: TaskDetail; connected: boolean; foreground: boolean; onClose: () => void;
  onChanged: () => void; onError: (message: string) => void;
}) {
  const { resolved } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [view, setView] = useState<TerminalView | null>(null);
  const reads = useMemo(() => ({ load: () => api.taskUnread(task.id), acknowledge: (ids: string[]) => api.markTaskRead(task.id, ids) }), [task.id]);
  const readState = useChatReadState(reads, connected, true, foreground);
  const current = useRef<TerminalView | null>(null);
  const cursor = useRef<{ generation?: string; cursor?: number }>({});
  const painted = useRef("");
  const readback = useRef<HTMLPreElement>(null);
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const [copyState, setCopyState] = useState("");
  const reading = useRef(false);
  const [error, setError] = useState("");
  const [inputError, setInputError] = useState("");
  const [action, setAction] = useState<"stop" | "close" | "restore" | "start" | null>(null);
  const actionRef = useRef(false);
  const updateEpoch = useRef(0);
  const [closing, setClosing] = useState<{ generation: string } | null>(null);
  const [retry, setRetry] = useState<{ generation: string; action: "stop" | "restore" | "start" } | null>(null);
  const [control, setControl] = useState(false);
  const controlRef = useRef(false);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const foregroundRef = useRef(foreground);
  foregroundRef.current = foreground;
  const pending = useRef<Input[]>([]);
  const sending = useRef(false);
  const blocked = useRef(false);
  const mounted = useRef(true);
  const inputTimer = useRef<number | undefined>(undefined);
  const sizeTimer = useRef<number | undefined>(undefined);
  const lastSize = useRef("");
  const drainRef = useRef<() => void>(() => undefined);
  const enqueueRef = useRef<(data: string, binary?: boolean) => boolean>(() => false);
  const syncSizeRef = useRef<() => void>(() => undefined);

  const drain = async () => {
    if (sending.current || blocked.current || actionRef.current || !connectedRef.current) return;
    sending.current = true;
    const generation = current.current?.generation;
    try {
      while (mounted.current && connectedRef.current && !actionRef.current && pending.current.length) {
        const item = pending.current[0]!;
        if (item.generation !== current.current?.generation) {
          pending.current = [];
          throw new Error("The shell changed. Unsent input was discarded; enter it again.");
        }
        await api.terminalInput(task.id, item.generation, item.id, item.data, item.binary);
        if (pending.current[0] === item) pending.current.shift();
      }
    } catch (error) {
      if (actionRef.current || current.current?.generation !== generation || current.current?.state !== "running") return;
      blocked.current = true;
      if (mounted.current) setInputError(error instanceof Error ? error.message : "Input delivery not confirmed. Retry safely.");
    } finally { sending.current = false; }
  };
  drainRef.current = () => void drain();
  const enqueue = (data: string, binary = false) => {
    if (!data || actionRef.current || !connectedRef.current || !foregroundRef.current || current.current?.state !== "running" || blocked.current) return false;
    // Coalesce keystrokes while preserving every byte and input order. One retry
    // identifier per batch prevents duplicate execution after a lost response.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 16000, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
      const chunk = data.slice(offset, end);
      const last = pending.current.at(-1);
      if (last && last.binary === binary && pending.current.length > (sending.current ? 1 : 0) && last.data.length + chunk.length <= 32000) last.data += chunk;
      else pending.current.push({ id: crypto.randomUUID(), generation: current.current.generation, data: chunk, binary });
      offset = end;
    }
    window.clearTimeout(inputTimer.current);
    inputTimer.current = window.setTimeout(() => drainRef.current(), 12);
    return true;
  };
  enqueueRef.current = enqueue;

  syncSizeRef.current = () => {
    const meta = current.current;
    if (!terminal.current || !meta || meta.state !== "running" || actionRef.current || !connectedRef.current || !foregroundRef.current) return;
    fit.current?.fit();
    const cols = Math.min(500, Math.max(2, terminal.current.cols));
    const rows = Math.min(200, Math.max(1, terminal.current.rows));
    const key = `${meta.generation}:${cols}:${rows}`;
    if (lastSize.current === key) return;
    lastSize.current = key;
    void api.resizeTerminal(task.id, meta.generation, cols, rows).catch(error => {
      lastSize.current = "";
      if (mounted.current) setError(error instanceof Error ? error.message : "Could not resize terminal");
    });
  };

  useLayoutEffect(() => {
    mounted.current = true;
    painted.current = "";
    // Keep xterm's default IME handling for direct mobile/Unicode input. The
    // selectable history view provides an ordinary accessible text transcript.
    const instance = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      allowProposedApi: false, disableStdin: true,
      theme: terminalTheme() });
    const addon = new FitAddon();
    instance.loadAddon(addon);
    terminal.current = instance;
    fit.current = addon;
    instance.open(host.current!);
    instance.textarea?.setAttribute("aria-label", "Interactive terminal");
    const disposeTouchScrolling = attachTerminalTouchScrolling(host.current!, instance);
    const input = instance.onData(data => {
      // Snapshots contain serialized screen state, not past terminal queries.
      // User input must keep flowing while a resize snapshot is being painted.
      if (controlRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        controlRef.current = false; setControl(false);
      }
      enqueueRef.current(data);
    });
    const binaryInput = instance.onBinary(data => enqueueRef.current(data, true));
    const viewport = () => {
      section.current?.style.setProperty("--terminal-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
      section.current?.style.setProperty("--terminal-top", `${window.visualViewport?.offsetTop ?? 0}px`);
    };
    const resize = () => {
      viewport();
      window.clearTimeout(sizeTimer.current);
      sizeTimer.current = window.setTimeout(() => syncSizeRef.current(), 100);
    };
    const observer = new ResizeObserver(resize);
    viewport();
    observer.observe(host.current!);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      mounted.current = false;
      window.clearTimeout(inputTimer.current); window.clearTimeout(sizeTimer.current);
      observer.disconnect(); window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
      disposeTouchScrolling(); input.dispose(); binaryInput.dispose(); instance.dispose(); terminal.current = null;
    };
  }, [task.id]);

  useLayoutEffect(() => {
    if (terminal.current) terminal.current.options.theme = terminalTheme();
  }, [resolved, task.id]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !connected || !foreground || view?.state !== "running" || Boolean(inputError) || Boolean(action);
    if (!connected && pending.current.length) {
      blocked.current = true;
      setInputError("Input delivery paused. Reconnect and retry safely.");
    }
  }, [connected, foreground, view?.state, inputError, action]);

  useEffect(() => {
    if (!connected) return;
    // Resync the screen after an interrupted read/paint, avoiding repeated deltas.
    cursor.current = {};
    lastSize.current = "";
    let stopped = false;
    let needsFit = true;
    let timer: number;
    const poll = async () => {
      try {
        const epoch = updateEpoch.current;
        const result = (await api.terminal(task.id, cursor.current.generation, cursor.current.cursor, foreground)).terminal;
        if (stopped || !terminal.current) return;
        if (epoch !== updateEpoch.current) { timer = window.setTimeout(() => void poll(), 0); return; }
        const first = !current.current || current.current.generation !== result.generation;
        setRetry(retry => retry && retry.generation !== result.generation ? null : retry);
        if (first && current.current) { pending.current = []; blocked.current = false; setInputError(""); }
        const instance = terminal.current;
        current.current = result;
        // Reconnects request a snapshot, but an unchanged snapshot is already
        // painted. Keep its content, scroll position and selection intact.
        const screenKey = `${result.generation}:${result.cursor}:${result.cols}:${result.rows}`;
        const replay = result.reset && painted.current !== screenKey;
        if (replay) {
          instance.reset(); instance.resize(result.cols, result.rows);
        }
        if (result.data && (!result.reset || replay)) {
          await new Promise<void>(resolve => instance.write(result.data, resolve));
        }
        if (stopped) return;
        if (epoch !== updateEpoch.current) { timer = window.setTimeout(() => void poll(), 0); return; }
        if (result.state !== "running") { pending.current = []; blocked.current = false; setInputError(""); }
        painted.current = screenKey;
        if (replay) fit.current?.fit();
        cursor.current = { generation: result.generation, cursor: result.cursor };
        setView(result); setError("");
        instance.options.disableStdin = !connectedRef.current || !foregroundRef.current || result.state !== "running" || blocked.current || actionRef.current;
        if (first || needsFit) { syncSizeRef.current(); needsFit = false; }
        if (first) onChanged();
        timer = window.setTimeout(() => void poll(), foreground && result.state === "running" ? 0 : 1500);
      } catch (error) {
        if (stopped) return;
        setError(error instanceof Error ? error.message : "Could not load terminal");
        timer = window.setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [task.id, connected, foreground]);

  useEffect(() => {
    if (view) readState.onMessagesLoaded(view.messages);
  }, [view?.messages]);

  useLayoutEffect(() => {
    if (selectionText !== null && readback.current) {
      readback.current.scrollTop = readback.current.scrollHeight;
      readback.current.focus({ preventScroll: true });
    } else if (reading.current) terminal.current?.focus();
    reading.current = selectionText !== null;
  }, [selectionText]);

  const running = view?.state === "running";
  const closed = view?.closed ?? task.status === "closed";
  const disabled = !connected || !foreground || !running || Boolean(inputError) || Boolean(action);
  const change = async (next: "stop" | "close" | "restore" | "start", generation: string) => {
    if (actionRef.current || !connectedRef.current) throw new Error("Reconnect before changing this terminal.");
    actionRef.current = true; setAction(next); setRetry(null);
    pending.current = []; blocked.current = true; setInputError("");
    terminal.current && (terminal.current.options.disableStdin = true);
    try {
      const result = next === "start" ? await api.startTerminal(task.id, generation) : await api.terminalAction(task.id, generation, next);
      if (!mounted.current) return;
      updateEpoch.current++;
      current.current = result.terminal; setView(result.terminal);
      cursor.current = {}; lastSize.current = "";
      setError(""); onChanged();
    } catch (error) {
      if (mounted.current && next !== "close") setRetry({ generation, action: next });
      throw error;
    } finally {
      actionRef.current = false;
      if (mounted.current) { blocked.current = false; setAction(null); }
    }
  };
  const run = (next: "stop" | "restore" | "start", generation: string) => {
    void change(next, generation).catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : "Could not update terminal"); });
  };
  const key = (data: string) => {
    if (!enqueue(data)) {
      setError("Input is paused. Reconnect or start a shell to continue."); return;
    }
    controlRef.current = false; setControl(false);
    setSelectionText(null);
    terminal.current?.scrollToBottom();
    terminal.current?.focus();
  };
  const arrow = (direction: string) => key(`${terminal.current?.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b["}${direction}`);

  return <section ref={section} className="session-page terminal-session" data-qahwa-id="terminal-session">
    <header className="session-header">
      <button type="button" className="icon-button" onClick={onClose} aria-label="Back"><ArrowLeft /></button>
      <span className="session-avatar task" aria-hidden="true"><TerminalIcon /></span>
      <div className="session-title"><span>{task.humanId}</span><strong>{task.title}</strong>
        <small className="session-subtitle">
          <span className="session-subtitle-text">{task.projectName} · Terminal</span>
          <span className="session-state-separator" aria-hidden="true">·</span>
          <span className="terminal-session-status" role="status">{!connected ? "Offline" : closed ? "Closed" : view?.state ?? "Connecting"}</span>
        </small>
      </div>
      <CodexUsageIndicator />
      <div className="terminal-actions" role="group" aria-label="Terminal session actions" aria-busy={Boolean(action)}>
        {closed ? <button type="button" className="icon-button terminal-session-action" aria-label={action === "restore" ? "Restoring session" : "Restore session"} title={action === "restore" ? "Restoring…" : "Restore session"} disabled={!connected || !view || Boolean(action)} onClick={() => view && run("restore", view.generation)}><RotateCcw aria-hidden="true" /></button> : <>
          <button type="button" className="icon-button terminal-session-action" aria-label={action === "stop" ? "Stopping terminal" : "Stop terminal"} title={action === "stop" ? "Stopping…" : "Stop terminal"} disabled={!connected || !view || !running || Boolean(action)} onClick={() => view && run("stop", view.generation)}><Square aria-hidden="true" /></button>
          <button type="button" className="icon-button danger-subtle terminal-session-action" aria-label="Close session" title="Close session" disabled={!connected || !view || Boolean(action)} onClick={() => view && setClosing({ generation: view.generation })}><X aria-hidden="true" /></button>
        </>}
          <TerminalControlButton className="terminal-text-action" aria-label={selectionText === null ? "Select terminal text" : "Back to live terminal"} aria-pressed={selectionText !== null} title={selectionText === null ? "Select and copy text" : "Back to live terminal"} onClick={() => {
            setCopyState("");
            setSelectionText(selectionText === null && terminal.current ? terminalText(terminal.current) : null);
          }}>{selectionText === null ? <TextSelect aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />}</TerminalControlButton>
      </div>
    </header>
    <div className="terminal-conversation">
      <article className="terminal-message" aria-label="Server terminal">
        <div className="terminal-output">
          <div className="terminal-screen" ref={host} data-qahwa-id="terminal-screen" aria-hidden={selectionText !== null} inert={selectionText !== null} />
          {selectionText !== null && <div className="terminal-readback">
            <div className="terminal-readback-hint">
              <span role="status">{copyState || (running ? "Select text to copy. Live output continues in the background." : "Select text to copy.")}</span>
              <TerminalControlButton className="terminal-text-action" aria-label="Copy terminal text" title="Copy selected text, or all text" onClick={async () => {
                const selected = window.getSelection();
                const text = selected?.anchorNode && selected.focusNode && readback.current?.contains(selected.anchorNode) && readback.current.contains(selected.focusNode)
                  ? selected.toString() || selectionText : selectionText;
                try { await navigator.clipboard.writeText(text); setCopyState("Copied"); }
                catch { setCopyState("Use your browser’s Copy action on the selected text."); }
              }}><Copy aria-hidden="true" /></TerminalControlButton>
            </div>
            <pre ref={readback} className="terminal-select-text" tabIndex={0} aria-label="Selectable terminal history">{selectionText}</pre>
          </div>}
        </div>
      </article>
      {(error || inputError || view?.error || !connected || (view && !running)) && <div className="terminal-notice" role="status">
        {inputError || error || (!connected ? "Reconnecting. Your shell keeps running; input is paused." : view?.error || `Shell exited with code ${view?.exitCode ?? "unknown"}.`)}
        {retry && <button type="button" className="secondary" disabled={!connected || Boolean(action)} onClick={() => run(retry.action, retry.generation)}>Retry {retry.action === "stop" ? "stop" : retry.action === "restore" ? "restore" : "start"}</button>}
        {inputError && <button type="button" className="secondary" disabled={!connected || !running || Boolean(action)} onClick={() => { blocked.current = false; setInputError(""); drainRef.current(); }}>Retry input</button>}
        {view && !running && !closed && <button type="button" className="secondary" disabled={!connected || Boolean(action)} onClick={() => run("start", view.generation)}>{action === "start" ? "Starting…" : "Start new shell"}</button>}
      </div>}
    </div>
    <div className="terminal-keys" role="toolbar" aria-label="Terminal keys">
      <TerminalControlButton disabled={disabled} aria-pressed={control} onClick={() => { controlRef.current = !controlRef.current; setControl(controlRef.current); terminal.current?.focus(); }}>Ctrl</TerminalControlButton>
      {[['Ctrl+C', '\x03'], ['Ctrl+D', '\x04'], ['Ctrl+Z', '\x1a'], ['Esc', '\x1b'], ['Tab', '\t']].map(([label, data]) => <TerminalControlButton key={label} disabled={disabled} onClick={() => key(data!)}>{label}</TerminalControlButton>)}
      <TerminalControlButton disabled={disabled} aria-label="Arrow up" onClick={() => arrow("A")}><ArrowUp /></TerminalControlButton>
      <TerminalControlButton disabled={disabled} aria-label="Arrow down" onClick={() => arrow("B")}><ArrowDown /></TerminalControlButton>
      <TerminalControlButton disabled={disabled} aria-label="Arrow left" onClick={() => arrow("D")}><ArrowLeft /></TerminalControlButton>
      <TerminalControlButton disabled={disabled} aria-label="Arrow right" onClick={() => arrow("C")}><ArrowRight /></TerminalControlButton>
      <TerminalControlButton disabled={disabled} onClick={() => key("\r")}>Enter</TerminalControlButton>
      <TerminalControlButton disabled={disabled} aria-label="Focus terminal keyboard" onClick={() => terminal.current?.focus()}><Keyboard /></TerminalControlButton>
    </div>
    {closing && <ActionDialog title="Close terminal session?" description="This stops the shell and its running work, then moves this conversation to Closed. Your transcript, history and project association are preserved. You can restore the session later."
      confirmLabel="Close session" pendingLabel="Closing…" destructive disabled={!connected}
      onClose={() => setClosing(null)} onConfirm={() => change("close", closing.generation)} />}
  </section>;
}
