import { ChatModelPicker } from "./ChatModelPicker";
import { defaultChatModel } from "../../domain/chat-model";
import { TaskSchedule } from "./TaskSchedule";
import { FollowupSchedule } from "./FollowupSchedule";
import { AttachmentMenu } from "./AttachmentMenu";
import { TaskActionsMenu } from "./TaskActionsMenu";
import { AlertCircle, ArrowLeft, Bot, BrainCircuit, Check, ChevronDown, ChevronUp, CircleCheck, Code2, Eraser, File, FilePenLine, Info, LoaderCircle, Mic, Pause, Pencil, Play, Search, Send, Sparkles, Square, Terminal, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { documentFromPlainText, plainTextFromDocument } from "../../domain/types";
import type { ChatAttachment, ChatExcerpt, ChatMessage, SelectedTaskReference, TaskDetail, TaskWorkspace, WorkActivity, WorkspaceCursor } from "../../domain/types";
import { api } from "../api";
import { CodexUsageIndicator } from "./CodexUsageIndicator";
import { SavedContentEditor, type SavedContent } from "./SavedContentEditor";
import { ActionDialog } from "./ActionDialog";
import { MessageBody, MessageResources } from "./MessageBody";
import { mergeWorkspace, mergeWorkspaceTail, reconcileHistory } from "../workspace-state";
import { useVoiceMessage } from "../use-voice-message";
import "../voice-message.css";
import { observeComposerInput } from "../composer-diagnostics";
import { useChatReadState } from "../use-chat-read-state";
import { TaskSelection } from "./TaskSelection";
import { appNotificationsReady, enableAppNotifications } from "../app-notifications";
import { UserAvatar } from "./UserAvatar";
import { OrchestratorAvatar } from "./OrchestratorAvatar";
import { DesignCanvas, type CanvasSelectionContext } from "./DesignCanvas";
import { DesignChatSheet } from "./DesignChatSheet";
import { ChatExcerptSelection, ExcerptPreview } from "./ChatExcerptSelection";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES = 250 * 1024 * 1024;

interface ComposerAttachment {
  localId: string;
  file: File;
  preview: string | null;
  attachment: ChatAttachment | null;
  progress: number;
  error: string | null;
}

interface Props {
  mode: "task" | "orchestrator";
  orchestratorName?: string;
  connected?: boolean;
  foreground?: boolean;
  taskId?: string;
  selectedTasks?: SelectedTaskReference[];
  onClearTaskSelection?: () => void;
  onRemoveTaskSelection?: (task: SelectedTaskReference) => void;
  onClose?: () => void;
  onChanged?: () => void;
  highlightedMessageIds?: ReadonlySet<string>;
  onMessagesLoaded?: (messages: ChatMessage[]) => void;
  onError: (message: string) => void;
}

export function SessionWorkspace({ mode, orchestratorName = "Orchestrator", connected = true, foreground = true, taskId, selectedTasks = [], onClearTaskSelection, onRemoveTaskSelection, onClose, onChanged, onError, highlightedMessageIds, onMessagesLoaded }: Props) {
  const [workspace, setWorkspace] = useState<TaskWorkspace | null>(null);
  const workspaceRef = useRef<TaskWorkspace | null>(null);
  const latestWorkspaceRef = useRef<TaskWorkspace | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const olderRequestRef = useRef<number | null>(null);
  const scrollAnchorRef = useRef<{ node: HTMLElement; top: number } | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [capacity, setCapacity] = useState<{ activeTurns: number; recommendedParallelism: number; availableSlots: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionDialog, setActionDialog] = useState<{ identity: string; kind: "clean" } | { identity: string; kind: "complete"; taskId: string } | { identity: string; kind: "cancel"; taskId: string; onlyIfUnstarted: boolean } | null>(null);
  const [editing, setEditing] = useState<{ kind: "task"; task: TaskDetail } | { kind: "message"; message: ChatMessage } | null>(null);
  const [cancellingMessage, setCancellingMessage] = useState<string | null>(null);
  const [runningMessageNow, setRunningMessageNow] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const restoreRef = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const messageActionRef = useRef(false);
  const chatIdentity = `${mode}:${taskId ?? "main"}`;
  const chatIdentityRef = useRef(chatIdentity);
  chatIdentityRef.current = chatIdentity;
  const [pushReady, setPushReady] = useState<boolean | null>(null);
  const [selectedDesignElement, setSelectedDesignElement] = useState<CanvasSelectionContext | null>(null);
  const [canvasSelectionResetKey, setCanvasSelectionResetKey] = useState(0);
  const [selectedExcerpt, setSelectedExcerpt] = useState<ChatExcerpt | null>(null);
  const [designChatOpen, setDesignChatOpen] = useState(false);
  const [canvasActionsContainer, setCanvasActionsContainer] = useState<HTMLDivElement | null>(null);
  const sessionRef = useRef<HTMLElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const workActivities = workspace?.workActivities ?? [];
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      // Mobile keyboards can resize only the visual viewport, leaving fixed
      // page insets behind the keyboard. Do not reflow chat during pinch zoom.
      if (viewport && viewport.scale !== 1) return;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      sessionRef.current?.style.setProperty("--chat-viewport-top", `${top}px`);
      sessionRef.current?.style.setProperty("--chat-viewport-bottom", `${Math.max(0, window.innerHeight - top - height)}px`);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    setPushReady(null);
    const check = () => {
      if (connected && mode === "task" && task?.idleNotificationsEnabled) {
        void appNotificationsReady().then(ready => { if (!stopped) setPushReady(ready); })
          .catch(() => { if (!stopped) setPushReady(false); });
      }
    };
    check();
    window.addEventListener("focus", check);
    return () => { stopped = true; window.removeEventListener("focus", check); };
  }, [connected, mode, task?.id, task?.idleNotificationsEnabled]);
  const messageResources = useMemo(() => ({ artifacts: task?.outputs?.flatMap(output => output.artifacts) ?? [], root: task?.rootDirectory ?? "" }), [task]);
  const hasDesign = mode === "task" && Boolean(taskId && workspace?.session.surface === "design" && workspace.design);
  const taskReads = useMemo(() => ({
    load: () => api.taskUnread(taskId!),
    acknowledge: (ids: string[]) => api.markTaskRead(taskId!, ids),
  }), [taskId]);
  const taskReadState = useChatReadState(taskReads, connected && mode === "task" && Boolean(taskId),
    mode === "task", foreground && (!hasDesign || designChatOpen));

  const cursorRef = useRef<WorkspaceCursor>({});
  const loadGenerationRef = useRef(0);
  const publishWorkspace = useCallback((saved: TaskWorkspace) => {
    const merged = mergeWorkspace(workspaceRef.current, saved);
    workspaceRef.current = merged;
    setWorkspace(merged);
  }, []);
  const acceptSavedWorkspace = useCallback((saved: TaskWorkspace) => {
    ++loadGenerationRef.current;
    cursorRef.current = {};
    latestWorkspaceRef.current = saved;
    publishWorkspace(mergeWorkspaceTail(workspaceRef.current, saved));
  }, [publishWorkspace]);
  const scheduleChanged = useCallback((saved: TaskWorkspace) => {
    if (chatIdentityRef.current === chatIdentity) acceptSavedWorkspace(saved);
  }, [chatIdentity, acceptSavedWorkspace]);
  const load = useCallback(async () => {
    if (olderRequestRef.current) return;
    const generation = ++loadGenerationRef.current;
    const current = () => generation === loadGenerationRef.current && chatIdentityRef.current === chatIdentity;
    const previous = workspaceRef.current;
    const cursor = cursorRef.current;
    const [taskResult, result] = mode === "task" && taskId
      ? await Promise.all([api.task(taskId), api.workspacePoll(taskId, cursor)])
      : [null, await api.orchestratorPoll(cursor)];
    // Ignore an old request after navigation or a newer action refresh.
    if (!current()) return;
    const latest = result.workspace ? mergeWorkspace(latestWorkspaceRef.current, result.workspace) : latestWorkspaceRef.current;
    if (!latest) throw new Error("Could not load session history");
    const reconciled = await reconcileHistory(latest, previous?.history?.oldestCursor,
      async query => (await api.messagePage(mode, taskId, query)).page, current);
    if (!current() || !reconciled) return;
    latestWorkspaceRef.current = latest;
    cursorRef.current = { revision: result.revision, messagesRevision: result.messagesRevision };
    if (taskResult) setTask((current) => JSON.stringify(current) === JSON.stringify(taskResult.task) ? current : taskResult.task);
    publishWorkspace(reconciled);
    if ("capacity" in result) {
      const { activeTurns, recommendedParallelism, availableSlots } = result.capacity;
      setCapacity((current) => current?.activeTurns === activeTurns && current.recommendedParallelism === recommendedParallelism && current.availableSlots === availableSlots ? current : { activeTurns, recommendedParallelism, availableSlots });
    }
  }, [mode, taskId, chatIdentity, publishWorkspace]);

  const loadOlder = async () => {
    const previous = workspaceRef.current;
    if (!connected || olderRequestRef.current || !previous?.history?.hasOlder || !previous.history.oldestCursor) return;
    setLoadingOlder(true);
    const generation = ++loadGenerationRef.current;
    olderRequestRef.current = generation;
    try {
      const { page } = await api.messagePage(mode, taskId, { before: previous.history.oldestCursor });
      if (generation !== loadGenerationRef.current || chatIdentityRef.current !== chatIdentity) return;
      const stream = chatRef.current;
      const top = stream?.getBoundingClientRect().top ?? 0;
      const anchor = Array.from(stream?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ?? [])
        .find(node => node.getBoundingClientRect().bottom > top);
      if (anchor) scrollAnchorRef.current = { node: anchor, top: anchor.getBoundingClientRect().top };
      pinnedToBottomRef.current = false;
      forceScrollRef.current = false;
      setHistoryError(null);
      publishWorkspace({ ...previous, messages: [...page.messages, ...previous.messages],
        history: { oldestCursor: page.oldestCursor ?? previous.history.oldestCursor, hasOlder: page.hasOlder } });
    } catch (error) {
      if (generation === loadGenerationRef.current && chatIdentityRef.current === chatIdentity) setHistoryError(error instanceof Error ? error.message : "Could not load older messages. Please retry.");
    } finally {
      if (olderRequestRef.current === generation) { olderRequestRef.current = null; setLoadingOlder(false); }
    }
  };

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (anchor && chatRef.current && anchor.node.isConnected) chatRef.current.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top;
    scrollAnchorRef.current = null;
  }, [workspace?.messages]);

  useEffect(() => {
    cursorRef.current = {};
    latestWorkspaceRef.current = null;
    workspaceRef.current = null;
    olderRequestRef.current = null;
    scrollAnchorRef.current = null;
    setLoadingOlder(false);
    setHistoryError(null);
    setWorkspace(null);
    setTask(null);
    setSelectedDesignElement(null);
    setSelectedExcerpt(null);
    setCancelError(null);
    setRestoreError(null);
    setEditing(null);
    setActionDialog(null);
    pinnedToBottomRef.current = true;
    forceScrollRef.current = true;
  }, [load]);
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: number;
    const poll = async (initial = false) => {
      try { await load(); }
      catch (error) { if (initial && !stopped) onError(error instanceof Error ? error.message : "Could not load session"); }
      if (!stopped) timer = window.setTimeout(() => void poll(), 1500);
    };
    void poll(true);
    return () => { stopped = true; window.clearTimeout(timer); ++loadGenerationRef.current; };
  }, [connected, load]);
  useEffect(() => {
    if (!forceScrollRef.current && !pinnedToBottomRef.current) return;
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    forceScrollRef.current = false;
  }, [workspace?.messages.length, designChatOpen]);
  useEffect(() => {
    if (!chatRef.current) return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottomRef.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    });
    observer.observe(chatRef.current);
    return () => observer.disconnect();
  }, [hasDesign]);
  useEffect(() => {
    if (workspace) {
      onMessagesLoaded?.(workspace.messages);
      if (mode === "task") taskReadState.onMessagesLoaded(workspace.messages);
    }
  }, [workspace?.messages, onMessagesLoaded, mode, taskReadState.onMessagesLoaded]);
  const act = async (work: () => Promise<unknown>) => {
    if (!connected) return false;
    setBusy(true);
    try { await work(); await load(); onChanged?.(); return true; }
    catch (error) { onError(error instanceof Error ? error.message : "Action failed"); return false; }
    finally { setBusy(false); }
  };
  const running = workspace?.session.runState === "running" || workspace?.session.runState === "waiting";
  const sessionStateLabel = workspace?.session.intakeState === "pending" && workspace.session.runState !== "not_started"
    ? "Clarifying scope" : workspace?.session.runState === "not_started" ? "Not started" : workspace?.session.runState;
  const cancelMessage = useCallback(async (messageId: string) => {
    if (!connected || busy || messageActionRef.current) return;
    messageActionRef.current = true;
    setCancellingMessage(messageId);
    setCancelError(null);
    try {
      const result = mode === "task" && taskId
        ? await api.cancelTaskMessage(taskId, messageId)
        : await api.cancelOrchestratorMessage(messageId);
      if (chatIdentityRef.current !== chatIdentity) return;
      ++loadGenerationRef.current;
      acceptSavedWorkspace(result.workspace);
      try { await load(); onChanged?.(); } catch { /* The saved cancellation is already shown. */ }
    } catch (error) {
      if (chatIdentityRef.current !== chatIdentity) return;
      setCancelError(error instanceof Error ? error.message : "Could not cancel message. Reconnect and retry.");
      try { await load(); } catch { /* Keep history available while offline. */ }
    } finally {
      messageActionRef.current = false;
      setCancellingMessage(null);
    }
  }, [connected, busy, mode, taskId, chatIdentity, load, onChanged]);
  const runMessageNow = useCallback(async (messageId: string) => {
    if (!connected || busy || messageActionRef.current) return;
    messageActionRef.current = true;
    setRunningMessageNow(messageId);
    setCancelError(null);
    try {
      const result = mode === "task" && taskId
        ? await api.runTaskMessageNow(taskId, messageId)
        : await api.runOrchestratorMessageNow(messageId);
      if (chatIdentityRef.current !== chatIdentity) return;
      ++loadGenerationRef.current;
      acceptSavedWorkspace(result.workspace);
      try { await load(); onChanged?.(); } catch { /* Server acceptance is already shown. */ }
    } catch (error) {
      if (chatIdentityRef.current !== chatIdentity) return;
      setCancelError(error instanceof Error ? error.message : "Could not run message. Reconnect and retry.");
      try { await load(); } catch { /* Keep the pending message available for retry. */ }
    } finally {
      messageActionRef.current = false;
      setRunningMessageNow(null);
    }
  }, [connected, busy, mode, taskId, chatIdentity, load, onChanged]);
  const editMessage = useCallback((message: ChatMessage) => setEditing({ kind: "message", message }), []);
  const contentOfMessage = (message: ChatMessage): SavedContent => ({ text: message.body, version: message.version!, canEdit: message.canEdit });
  const contentOfTask = (task: TaskDetail): SavedContent => ({ text: plainTextFromDocument(task.description), title: task.title, version: task.version, canEdit: task.canEdit });
  const saveEdit = async (draft: SavedContent) => {
    if (!editing) return;
    const identity = chatIdentity;
    if (editing.kind === "task") {
      const original = editing.task;
      const description = draft.text === plainTextFromDocument(original.description) ? original.description : documentFromPlainText(draft.text);
      const { task: saved } = await api.editTask(original.id, { title: draft.title!, description, expectedVersion: draft.version });
      if (chatIdentityRef.current !== identity) return;
      ++loadGenerationRef.current;
      setTask(saved);
    } else {
      const { workspace: saved } = mode === "task" && taskId
        ? await api.editTaskMessage(taskId, editing.message.id, draft.text, draft.version)
        : await api.editOrchestratorMessage(editing.message.id, draft.text, draft.version);
      if (chatIdentityRef.current !== identity) return;
      ++loadGenerationRef.current;
      acceptSavedWorkspace(saved);
    }
    // A refresh failure must not turn an accepted edit into a failed save.
    try { await load(); onChanged?.(); } catch { /* Polling will reconcile the saved content. */ }
  };
  const latestEdit = async (): Promise<SavedContent> => {
    if (editing?.kind === "task") return contentOfTask((await api.task(editing.task.id)).task);
    await load();
    const message = workspaceRef.current?.messages.find(message => message.id === (editing?.kind === "message" ? editing.message.id : ""));
    if (!message) throw new Error("This message is no longer in this chat.");
    return contentOfMessage(message);
  };
  const send = async (text: string, attachmentIds: string[], excerpt: ChatExcerpt | null) => {
    if (!connected) return false;
    forceScrollRef.current = true;
    const selectedTaskIds = selectedTasks.map(({ id }) => id);
    setBusy(true);
    try {
      const result = mode === "task" && taskId
        ? await api.sendTaskMessage(taskId, text, attachmentIds, workspace?.selectedDesignPageId ?? null, excerpt)
        : await api.sendOrchestratorMessage(text, attachmentIds, selectedTaskIds, excerpt);
      if (chatIdentityRef.current !== chatIdentity) return true;
      acceptSavedWorkspace(result.workspace);
      setSelectedExcerpt(null);
      setSelectedDesignElement(null);
      setCanvasSelectionResetKey(current => current + 1);
      onClearTaskSelection?.();
      // Acceptance is durable even if the following refresh fails. Keeping the
      // sent draft here would invite a duplicate reply on retry.
      void load().then(() => {
        if (chatIdentityRef.current === chatIdentity) onChanged?.();
      }).catch(() => {
        if (chatIdentityRef.current === chatIdentity) onError("Message saved. Could not refresh the chat yet.");
      });
      return true;
    } catch (error) { onError(error instanceof Error ? error.message : "Could not send message"); return false; }
    finally { setBusy(false); }
  };

  return <section ref={sessionRef} className={`chat-session ${mode === "task" ? `session-page${hasDesign ? " design-session" : ""}` : "orchestrator-page"}`}>
    <header className="session-header">
      {onClose && <button type="button" className="icon-button" onClick={onClose} aria-label="Back"><ArrowLeft /></button>}
      <span className={`session-avatar ${mode}`} aria-hidden="true">{mode === "task" ? <Bot /> : <OrchestratorAvatar />}</span>
      <div className="session-title">
        <span>{mode === "task" ? task?.humanId ?? "Task" : orchestratorName}</span>
        <strong>{mode === "task" ? task?.title ?? "Loading…" : "Portfolio coordination"}</strong>
        <small className="session-subtitle">
          <span className="session-subtitle-text">{mode === "task" ? task?.projectName ?? "" : "A calm view across every task"}</span>
          {workspace && <><span className="session-state-separator" aria-hidden="true">·</span><span className={`session-state run-${workspace.session.runState}`} role="status">{sessionStateLabel}</span></>}
          {mode === "task" && task && <><span className="session-state-separator" aria-hidden="true">·</span><span className="session-task-status">{task.status.replaceAll("_", " ")}</span></>}
        </small>
      </div>
      {mode === "task" && <CodexUsageIndicator />}
      {mode === "orchestrator" && capacity && <span className="capacity-pill"><i />{capacity.activeTurns} active <b>·</b> {capacity.availableSlots} available</span>}
      {mode === "orchestrator" && <button type="button" className="icon-button" disabled={busy || running || !connected} onClick={() => {
        setActionDialog({ identity: chatIdentity, kind: "clean" });
      }} aria-label={`Clean ${orchestratorName}`} title={`Clean ${orchestratorName}`}><Eraser /></button>}
      {mode === "orchestrator" && running && <button type="button" className="icon-button warning session-interrupt" disabled={!connected || busy} onClick={() => void act(() => api.interruptOrchestrator())} aria-label="Interrupt" title="Interrupt"><Pause aria-hidden="true" /></button>}
    </header>

    {workspace && (mode === "orchestrator" || task) && <div className="session-actions">
      <ChatModelPicker key={chatIdentity} settings={workspace.modelSettings ?? defaultChatModel(mode)} disabled={!connected}
        onSave={async settings => {
          const { workspace: saved } = await api.saveChatModel(mode, taskId, settings);
          if (chatIdentityRef.current === chatIdentity) acceptSavedWorkspace(saved);
        }} />
      {hasDesign && <div className="session-canvas-actions" ref={setCanvasActionsContainer} />}
      {mode === "task" && task?.status === "closed" && <button type="button" className="secondary" title="Move to Backlog without starting work"
        disabled={!connected || busy || restoring || running} onClick={async () => {
          if (!connected || busy || running || restoreRef.current) return;
          restoreRef.current = true; setRestoring(true); setRestoreError(null);
          const identity = chatIdentity;
          try {
            const { task: saved } = await api.restoreTask(task.id, task.version);
            if (chatIdentityRef.current !== identity) return;
            ++loadGenerationRef.current;
            setTask(saved); onChanged?.();
            try { await load(); } catch { onError("Session restored. Could not refresh the chat yet."); }
          } catch (error) {
            if (chatIdentityRef.current !== identity) return;
            // Reconcile an acknowledgement lost after the server saved, or a
            // restore performed on another device. Never retry automatically.
            try {
              const { task: latest } = await api.task(task.id);
              if (chatIdentityRef.current !== identity) return;
              ++loadGenerationRef.current; setTask(latest); onChanged?.();
              await load();
              if (latest.status === "backlog" && latest.version > task.version) return;
            } catch { /* Keep the error and allow a deliberate retry after reconnect. */ }
            setRestoreError(error instanceof Error ? error.message : "Could not restore session. Reconnect and retry.");
          } finally { restoreRef.current = false; setRestoring(false); }
        }}>{restoring ? "Restoring…" : "Restore session"}</button>}
      {mode === "task" && task && task.status !== "closed" && <>
        {task.canEdit && <button type="button" className="icon-button" disabled={busy || !connected} onClick={() => setEditing({ kind: "task", task })} aria-label="Edit task" title="Edit task"><FilePenLine aria-hidden="true" /></button>}

      </>}
      {mode === "task" && task && <TaskActionsMenu key={chatIdentity} running={running} closed={task.status === "closed"} notificationsEnabled={task.idleNotificationsEnabled}
          onToggleNotifications={() => void act(async () => {
            if (!task.idleNotificationsEnabled) { await enableAppNotifications(); setPushReady(true); }
            const { task: savedTask } = await api.setIdleNotifications(task.id, !task.idleNotificationsEnabled);
            setTask(current => current?.id === savedTask.id ? savedTask : current);
          })} disabled={busy || !connected || !workspace}
          onPause={() => { if (running) void act(() => api.interruptTask(task.id)); }}
          onCancel={() => setActionDialog({ identity: chatIdentity, kind: "cancel", taskId: task.id,
            onlyIfUnstarted: (task.status === "backlog" || task.status === "todo") && workspace?.session.runState === "not_started" })}
          onComplete={() => setActionDialog({ identity: chatIdentity, kind: "complete", taskId: task.id })} />}
    </div>}

    {mode === "task" && workspace?.session.accessReason && <p className="task-access-status" role="status">{workspace.session.accessReason}</p>}
    {mode === "task" && running && workspace?.session.activeAccessMode !== workspace?.session.accessMode && <p className="task-access-status" role="status">
      Current turn: {workspace?.session.activeAccessMode === "read-only" ? "read-only" : "editing"}. Requested access applies to the next turn.
    </p>}
    {restoreError && <p className="message-cancel-error" role="alert">{restoreError}</p>}

    {mode === "task" && task && workspace && <TaskSchedule key={task.id} taskId={task.id} schedule={workspace.schedule ?? null}
      eligible={workspace.session.runState === "not_started" && ["backlog", "todo"].includes(task.status)} disabled={busy || !connected}
      onChanged={async () => { await load(); onChanged?.(); }} />}

    {mode === "task" && task?.idleNotificationsEnabled && pushReady === false && <div className="notification-device-prompt" role="status">
      <span>Allow Qahwa Tasks notifications on this device to receive idle alerts.</span>
      <button type="button" disabled={!connected || busy} onClick={() => void act(async () => {
        await enableAppNotifications(); setPushReady(true);
      })}>Enable on this device</button>
    </div>}

    <div className={hasDesign ? "design-workspace" : "chat-workspace"}>
    {mode === "task" && taskId && workspace?.session.surface === "design" && workspace.design && <DesignCanvas workspace={workspace} taskId={taskId} actionsContainer={canvasActionsContainer} selectionResetKey={canvasSelectionResetKey} onSelect={setSelectedDesignElement} comments={task?.comments ?? []} connected={connected} activityTitle={lastRunningTitle(workActivities)} onChanged={load} onError={onError} />}

    <DesignChatSheet enabled={hasDesign} taskId={taskId} connected={connected} pending={workspace?.pendingRequests.length ?? 0} onOpenChange={setDesignChatOpen}>
    <div className="chat-stream" ref={chatRef} onScroll={(event) => {
      const element = event.currentTarget;
      pinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    }}>
      <div className="chat-history">
      {workspace?.history?.hasOlder && <div className="chat-history-loader">
        <button type="button" className="secondary" disabled={!connected || loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? "Loading older messages…" : "Load older messages"}
        </button>
        {historyError && <p role="alert">{historyError}</p>}
      </div>}
      {workspace?.messages.length === 0 && <div className="session-empty"><span className="empty-orb">{mode === "task" ? <Sparkles /> : <OrchestratorAvatar />}</span><span className="empty-kicker">{mode === "task" ? "Dedicated session" : "One clear overview"}</span><h2>{mode === "task" ? "Ready when you are" : "Plan the work, not every move"}</h2><p>{mode === "task" ? "Start this task when you want its session to understand the note, ask what is missing, and choose between a focused chat or design canvas." : `Discuss priorities, dependencies, and what can safely run together. ${orchestratorName} watches progress and speaks up when something matters.`}</p></div>}
      <MessageResources.Provider value={messageResources}><MessageHistory orchestratorName={orchestratorName} pages={workspace?.designPages} messages={workspace?.messages} mode={mode} highlightedIds={mode === "task" ? taskReadState.highlightedIds : highlightedMessageIds} onEdit={editMessage} onCancel={cancelMessage} onRunNow={runMessageNow} cancelDisabled={!connected || busy || cancellingMessage !== null || runningMessageNow !== null} cancellingMessage={cancellingMessage} runningMessageNow={runningMessageNow} onScheduleChanged={scheduleChanged} /></MessageResources.Provider>
      {workspace?.pendingRequests.map((pending) => <PendingCard key={pending.id} pending={pending} disabled={!connected || busy} onResolve={(body) => void act(() => api.respondToRequest(pending.id, body))} />)}
      <div />
      </div>
    </div>

    {workspace && running && <div className="active-work-panel"><WorkLog activities={workActivities} running waiting={workspace.session.runState === "waiting"} /></div>}
    {mode === "orchestrator" && selectedTasks.length > 0 && onClearTaskSelection && onRemoveTaskSelection && <TaskSelection tasks={selectedTasks} onClear={onClearTaskSelection} onRemove={onRemoveTaskSelection} />}

    <ChatExcerptSelection key={`${mode}:${taskId ?? "main"}`} stream={chatRef} messages={workspace?.messages}
      disabled={busy || (mode === "task" && (task?.status === "closed" || (workspace?.session.runState === "not_started" && !(workspace.hasPendingMessages ?? workspace.messages.some(entry => entry.pending)))))}
      onSelect={setSelectedExcerpt} />
    {cancelError && <p className="message-cancel-error" role="alert">{cancelError}</p>}
    <ChatComposer mode={mode} connected={connected} taskId={taskId} task={task} runState={workspace?.session.runState} hasPendingMessages={workspace?.hasPendingMessages ?? workspace?.messages.some((entry) => entry.pending) ?? false} running={running} busy={busy || workspace?.schedule?.state === "pending"} selectedDesignElement={selectedDesignElement} onClearSelection={() => { setSelectedDesignElement(null); setCanvasSelectionResetKey(current => current + 1); }} selectedExcerpt={selectedExcerpt} onClearExcerpt={() => setSelectedExcerpt(null)} onSend={send} onStart={() => taskId && void act(() => api.triggerTask(taskId))} onError={onError} />
    </DesignChatSheet>
    </div>

    {actionDialog?.identity === chatIdentity && <ActionDialog title={actionDialog.kind === "clean" ? `Clean ${orchestratorName}’s chat?` : actionDialog.kind === "complete" ? "Mark this task completed?" : "Cancel this task?"}
      description={actionDialog.kind === "clean" ? "Start a fresh session. Your saved name and custom instructions will be kept." : actionDialog.kind === "complete" ? "This will close the task as completed. Its history and attachments will be kept." : "Its history and attachments will be kept."}
      confirmLabel={actionDialog.kind === "clean" ? "Clean chat" : actionDialog.kind === "complete" ? "Mark completed" : "Cancel task"}
      pendingLabel={actionDialog.kind === "clean" ? "Cleaning…" : actionDialog.kind === "complete" ? "Completing…" : "Cancelling…"}
      destructive={actionDialog.kind !== "complete"} disabled={!connected || busy || running || (actionDialog.kind !== "clean" && (!task || task.status === "closed"))}
      onConfirm={async () => {
        if (!connected || busy || running || chatIdentityRef.current !== actionDialog.identity
          || (actionDialog.kind !== "clean" && (!task || task.status === "closed"))) throw new Error("This action is no longer available. Close the dialog and refresh.");
        setBusy(true);
        try {
          if (actionDialog.kind === "clean") await api.cleanOrchestrator();
          else if (actionDialog.kind === "complete") await api.transition(actionDialog.taskId, "closed", "completed");
          else await api.transition(actionDialog.taskId, "closed", "cancelled", actionDialog.onlyIfUnstarted);
          if (chatIdentityRef.current !== actionDialog.identity) return;
          try { await load(); onChanged?.(); } catch { onError("Action saved. Could not refresh the chat yet."); }
        } finally { setBusy(false); }
      }} onClose={() => setActionDialog(current => current === actionDialog ? null : current)} />}
    {editing && <SavedContentEditor key={`${chatIdentity}:${editing.kind}:${editing.kind === "task" ? editing.task.id : editing.message.id}`} kind={editing.kind}
      initial={editing.kind === "task" ? contentOfTask(editing.task) : contentOfMessage(editing.message)} connected={connected}
      onSave={saveEdit} onLatest={latestEdit} onClose={() => setEditing(current => current === editing ? null : current)} />}
  </section>;
}


interface ComposerProps {
  mode: Props["mode"];
  connected: boolean;
  taskId?: string;
  task: TaskDetail | null;
  runState?: TaskWorkspace["session"]["runState"];
  hasPendingMessages: boolean;
  running: boolean;
  busy: boolean;
  selectedDesignElement: CanvasSelectionContext | null;
  onClearSelection: () => void;
  selectedExcerpt: ChatExcerpt | null;
  onClearExcerpt: () => void;
  onSend: (text: string, attachmentIds: string[], excerpt: ChatExcerpt | null) => Promise<boolean>;
  onStart: () => void;
  onError: Props["onError"];
}

function ChatComposer({ mode, connected, taskId, task, runState, hasPendingMessages, running, busy, selectedDesignElement, onClearSelection, selectedExcerpt, onClearExcerpt, onSend, onStart, onError }: ComposerProps) {
  const [message, setMessage] = useState("");
  const voice = useVoiceMessage(mode, taskId);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const composerFieldRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  useEffect(() => {
    if (selectedExcerpt) messageInputRef.current?.focus({ preventScroll: true });
  }, [selectedExcerpt]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    for (const item of attachmentsRef.current) if (item.preview) URL.revokeObjectURL(item.preview);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!connected || busy || sendingRef.current || voice.blocked) return;
    const text = [message.trim(), voice.phase === "review" ? voice.transcript.trim() : ""].filter(Boolean).join("\n\n");
    const readyAttachments = attachments.map((item) => item.attachment).filter((item): item is ChatAttachment => Boolean(item));
    if ((!text && readyAttachments.length === 0) || attachments.some((item) => !item.attachment || item.error)) return;
    const contextual = selectedDesignElement ? `${text}\n\n${selectedDesignElement.count > 1 ? "Selected canvas elements:\n" : "Selected canvas element: "}${selectedDesignElement.label}` : text;
    const attachmentIds = readyAttachments.map((item) => item.id);
    sendingRef.current = true;
    setSending(true);
    void (async () => {
      try {
        const sent = await onSend(contextual, attachmentIds, selectedExcerpt);
        if (!sent) return;
        const input = messageInputRef.current;
        if (input) {
          input.setSelectionRange(0, 0);
          input.blur();
          window.getSelection()?.removeAllRanges();
        }
        voice.cancel();
        setMessage((current) => current === message ? "" : current);
        setAttachments([]);
        for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      } finally { sendingRef.current = false; setSending(false); }
    })();
  };
  const addFiles = (files: File[]) => {
    if (!connected || busy) return;
    if (!files.length) return;
    const combined = [...attachments.map((item) => item.file), ...files];
    if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) { onError("Each file may be at most 100 MiB"); return; }
    if (combined.reduce((sum, file) => sum + file.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) { onError("Files may total at most 250 MiB per message"); return; }
    const additions = files.map((file): ComposerAttachment => ({
      localId: crypto.randomUUID(), file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      attachment: null, progress: 0, error: null,
    }));
    setAttachments((current) => [...current, ...additions]);
    for (const item of additions) void api.uploadAttachment(mode, taskId, item.file, (progress) => {
      setAttachments((current) => current.map((entry) => entry.localId === item.localId ? { ...entry, progress } : entry));
    }).then((attachment) => {
      setAttachments((current) => current.map((entry) => entry.localId === item.localId ? { ...entry, attachment, progress: 100 } : entry));
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Upload failed";
      setAttachments((current) => current.map((entry) => entry.localId === item.localId ? { ...entry, error: message } : entry));
      onError(message);
    });
  };
  const removeAttachment = (item: ComposerAttachment) => {
    if (!item.attachment && !item.error) return;
    setAttachments((current) => current.filter((entry) => entry.localId !== item.localId));
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.attachment) void api.removeAttachment(item.attachment.id).catch((error) => onError(error instanceof Error ? error.message : "Could not remove file"));
  };
  const composerVisible = !(mode === "task" && (task?.status === "closed" || (runState === "not_started" && !hasPendingMessages)));
  useLayoutEffect(() => {
    const input = messageInputRef.current;
    const field = composerFieldRef.current;
    if (!input || !field) return;
    // Measure wrapping at the collapsed width even while focused. This keeps
    // long drafts expanded on blur without a width/height feedback loop.
    const measure = document.createElement("textarea");
    measure.className = "composer-message composer-measure";
    measure.tabIndex = -1;
    measure.setAttribute("aria-hidden", "true");
    field.append(measure);
    const resize = () => {
      const style = getComputedStyle(field);
      const buttonWidth = field.querySelector(".attach-button")?.getBoundingClientRect().width ?? 44;
      measure.style.width = `${Math.max(1, field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - buttonWidth * 3 - parseFloat(style.columnGap) * 3)}px`;
      measure.value = input.value;
      const textStyle = getComputedStyle(measure);
      const singleLine = parseFloat(textStyle.lineHeight) + parseFloat(textStyle.paddingTop) + parseFloat(textStyle.paddingBottom);
      setMultiline(measure.scrollHeight > singleLine + 1);
      input.style.height = "0px";
      // Bound the preferred height as well as max-height: an unbounded pixel
      // height makes the grid reserve the whole draft before its percentage
      // max-height resolves. Keep that percentage so a short viewport can still
      // shrink the textarea to its grid row without clipping its top edge.
      input.style.height = `min(${input.scrollHeight}px, var(--composer-message-max-height))`;
    };
    resize();
    let previousWidth = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === previousWidth) return;
      previousWidth = input.clientWidth;
      resize();
    });
    observer.observe(input);
    return () => { observer.disconnect(); measure.remove(); };
  }, [message, composerVisible]);
  useEffect(() => {
    if (!composerVisible || (!connected && voice.phase === "requesting")) voice.cancel();
    else if (!connected && voice.phase === "recording") voice.stop();
  }, [connected, composerVisible, voice.phase, voice.cancel]);
  useEffect(() => {
    const element = messageInputRef.current;
    if (!element) return;
    return observeComposerInput(element, (message) => { void api.clientDiagnostic("composer-input-v17", message).catch(() => undefined); });
  }, [mode, taskId, composerVisible]);

  return <form className={`chat-composer${dragging ? " dragging" : ""}`} onSubmit={submit} onDragEnter={(event) => { event.preventDefault(); if (!busy && connected) setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy && connected) addFiles(Array.from(event.dataTransfer.files)); }}>
      {mode === "task" && task?.status === "closed" ? <div className="closed-composer">Task {task.outcome}</div> : mode === "task" && runState === "not_started" && !hasPendingMessages ? <button className="primary trigger-button" type="button" disabled={busy || !connected} onClick={() => void onStart()}><Play /> Clarify &amp; start</button> : <>
        <div ref={composerFieldRef} className={`composer-field${multiline || attachments.length > 0 || voice.phase !== "idle" || selectedDesignElement || selectedExcerpt ? " expanded" : ""}`} onPointerDown={event => {
          // Keep controls from moving between pointer-down and click, and keep
          // the mobile keyboard open when acting on a focused draft.
          if (event.button === 0 && (event.target as Element).closest(".attach-button, .voice-record-button, .send-button")) event.preventDefault();
        }}>
        {(voice.phase !== "idle" || selectedDesignElement || selectedExcerpt || attachments.length > 0) && <div className="composer-context">{selectedExcerpt && <div className="composer-excerpt" role="region" aria-label="Reply context"><ExcerptPreview excerpt={selectedExcerpt} /><button type="button" disabled={sending} onClick={() => { onClearExcerpt(); messageInputRef.current?.focus({ preventScroll: true }); }} aria-label="Clear reply context"><X /></button></div>}{voice.phase !== "idle" && <div className="voice-panel" aria-label="Voice message">
          <div className="voice-heading"><span role="status">{voice.phase === "recording" ? `Recording ${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, "0")} / 5:00` : voice.phase === "requesting" ? "Preparing microphone…" : voice.phase === "processing" ? "Transcribing…" : voice.phase === "review" ? "Review your transcript before Send" : "Voice message needs attention"}</span><button type="button" disabled={sending} onClick={voice.cancel} aria-label="Cancel voice message"><X /></button></div>
          {voice.phase === "recording" && <button className="voice-stop" type="button" onClick={voice.stop}><Square aria-hidden="true" /> Stop recording</button>}
          {voice.preview && <audio controls preload="metadata" src={voice.preview} aria-label="Recording preview" />}
          {voice.error && <p role="alert">{voice.error}</p>}
          {voice.phase === "error" && <button type="button" disabled={!connected} onClick={voice.retry}>Retry voice message</button>}
          {voice.phase === "review" && <><textarea aria-label="Voice transcript" value={voice.transcript} onChange={(event) => voice.setTranscript(event.target.value)} readOnly={sending} rows={3} /><small>Only text will be sent, together with your typed draft.</small></>}
        </div>}{selectedDesignElement && <span className="canvas-selection">Canvas · {selectedDesignElement.label}<button type="button" onClick={() => onClearSelection()} aria-label="Clear selection"><X /></button></span>}{attachments.length > 0 && <div className="composer-attachments" role="region" aria-label="Files to send" tabIndex={0}>{attachments.map((item) => <div className={`attachment-chip${item.preview ? " image" : ""}${item.error ? " error" : ""}`} key={item.localId}>{item.preview ? <img src={item.preview} alt={`Preview of ${item.file.name}`} /> : <File aria-hidden="true" />}<span><strong title={item.file.name}>{item.file.name}</strong><small role={item.error ? "alert" : "status"}>{item.error ?? (item.attachment ? formatFileSize(item.file.size) : `Uploading ${item.progress}%`)}</small></span><button type="button" disabled={!item.attachment && !item.error} onClick={() => removeAttachment(item)} aria-label={`Remove ${item.file.name}`}><X /></button>{!item.attachment && !item.error && <progress value={item.progress} max={100} aria-label={`Uploading ${item.file.name}`} />}</div>)}</div>}</div>}
        <textarea aria-label="Message" inputMode="text" className="composer-message" ref={messageInputRef} placeholder={running ? "You can draft while this session works…" : mode === "task" ? "Ask, clarify, or guide this task…" : "Discuss priorities or ask for an update…"} value={message} onChange={(event) => setMessage(event.target.value)} rows={1} />
        <AttachmentMenu disabled={busy || !connected} onFiles={addFiles} />
        <button className="voice-record-button" type="button" disabled={busy || sending || !connected || !voice.supported || voice.phase !== "idle"} onClick={() => void voice.start()} aria-label="Record voice message" title="Record a voice message (five minutes maximum)"><Mic /></button>
        <button className="send-button" type="submit" disabled={busy || sending || voice.blocked || !connected || attachments.some((item) => !item.attachment || Boolean(item.error)) || (!message.trim() && !attachments.some((item) => item.attachment) && !(voice.phase === "review" && voice.transcript.trim()))} aria-label="Send"><Send /></button>
        </div>
        {!voice.supported && <span className="voice-unsupported" role="status">Voice recording needs a supported browser with HTTPS and microphone access.</span>}
      </>}
    </form>;
}

interface MessageControls { onEdit: (message: ChatMessage) => void; onCancel: (id: string) => Promise<void>; onRunNow: (id: string) => Promise<void>; runningMessageNow: string | null; cancelDisabled: boolean; cancellingMessage: string | null; onScheduleChanged: (workspace: TaskWorkspace) => void }

const MessageHistory = memo(function MessageHistory({ messages, mode, highlightedIds, orchestratorName, pages, ...controls }: MessageControls & { pages?: TaskWorkspace["designPages"]; messages?: ChatMessage[]; mode: Props["mode"]; highlightedIds?: ReadonlySet<string>; orchestratorName: string }) {
  return <>{messages?.map((entry) => <MessageEntry key={entry.id} entry={entry} mode={mode} orchestratorName={orchestratorName} pageName={pages?.find(page => page.id === entry.metadata?.designPageId)?.name} unread={highlightedIds?.has(entry.id) ?? false} {...controls} />)}</>;
});

const MessageEntry = memo(function MessageEntry({ entry, mode, unread, orchestratorName, pageName, onEdit, onCancel, onRunNow, runningMessageNow, cancelDisabled, cancellingMessage, onScheduleChanged }: MessageControls & { pageName?: string; entry: ChatMessage; mode: Props["mode"]; unread: boolean; orchestratorName: string }) {
  if (entry.role === "system") {
    const preview = entry.body.trim().split(/\r?\n/, 1)[0]
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, "")
      .replace(/[*_`]/g, "").slice(0, 140) || "System update";
    return <article id={`chat-message-${entry.id}`} data-chat-message-id={entry.id} tabIndex={-1} className="chat-message system">
      <details className="system-message">
        <summary className="system-message-summary" aria-label={`System info: ${preview}`}>
          <Info aria-hidden="true" />
          <span className="system-message-preview">{preview}</span>
          <time dateTime={entry.createdAt}>{formatMessageTime(entry.createdAt)}</time>
          <ChevronDown className="system-message-chevron" aria-hidden="true" />
        </summary>
        <div className="system-message-body"><MessageBody entry={entry} /></div>
      </details>
    </article>;
  }
  return <article id={`chat-message-${entry.id}`} data-chat-message-id={entry.id} tabIndex={-1} className={`chat-message ${entry.role}${unread ? " unread-message" : ""}`}>
        <span className="message-avatar" aria-hidden="true">{entry.role === "user" ? <UserAvatar /> : mode === "task" ? <Bot /> : <OrchestratorAvatar />}</span>
        <div className="message-content"><div className="message-role">
          <div className="message-metadata"><span className="message-sender" title={entry.role === "assistant" && mode === "orchestrator" ? orchestratorName : undefined}>{entry.role === "assistant" ? mode === "task" ? "Task session" : orchestratorName : "You"}</span><time>{formatMessageTime(entry.createdAt)}</time>
          {entry.pending && <span className="message-pending-control"><span className="message-pending" title="Saved. Unread by the agent until processing starts." role="status">Pending</span>
            {entry.role === "user" && entry.canRunNow && <button type="button" className="message-action message-run-now" aria-label={runningMessageNow === entry.id ? "Starting message…" : "Run now"} title="Run now — bypass pending mode" disabled={cancelDisabled} onPointerDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={() => void onRunNow(entry.id)}>{runningMessageNow === entry.id ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}</button>}
          </span>}</div>
          {entry.role === "user" && entry.pending && (entry.canEdit || entry.canCancel) && <div className="message-actions">
            {entry.canEdit && <button type="button" className="message-action message-edit" aria-label="Edit message" title="Edit message" disabled={cancelDisabled} onPointerDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={() => onEdit(entry)}><Pencil aria-hidden="true" /></button>}
            {entry.canCancel && <button type="button" className="message-action message-cancel" aria-label={cancellingMessage === entry.id ? "Cancelling…" : "Cancel message"} title="Cancel message" disabled={cancelDisabled} onPointerDown={event => {
              // Preserve composer focus so a tap cannot move its own target.
              if (event.button === 0) event.preventDefault();
            }} onClick={() => void onCancel(entry.id)}>{cancellingMessage === entry.id ? <LoaderCircle className="spin" aria-hidden="true" /> : <X aria-hidden="true" />}</button>}
          </div>}
        </div>
        {entry.editedAt && <small className="message-edited">Edited</small>}
        {entry.schedule && <FollowupSchedule taskId={entry.schedule.taskId} message={entry} disabled={cancelDisabled} onChanged={onScheduleChanged} />}
        {entry.cancelledAt && <span className="message-cancelled" role="status">Cancelled</span>}
        {entry.role === "user" && entry.metadata?.selectedTasks && entry.metadata.selectedTasks.length > 0 && <div className="message-task-selection"><strong>{entry.metadata.selectedTasks.length} selected at send</strong><ul>{entry.metadata.selectedTasks.map((task) => <li key={task.id}>{task.humanId} · {task.title}</li>)}</ul></div>}
        {pageName && <small className="message-canvas-page">Page · {pageName}</small>}
        {entry.metadata?.selectedExcerpt && <ExcerptPreview excerpt={entry.metadata.selectedExcerpt} />}
        <MessageBody entry={entry} /></div>
      </article>;
});

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 ** 2).toFixed(size < 10 * 1024 ** 2 ? 1 : 0)} MiB`;
}

function WorkLog({ activities, running, waiting }: { activities: WorkActivity[]; running: boolean; waiting: boolean }) {
  const [expanded, setExpanded] = useState(running);
  useEffect(() => { if (running) setExpanded(true); }, [running]);
  const hasError = activities.some((item) => item.status === "error");
  const heading = waiting ? "Waiting for you" : running ? "Codex is working" : hasError ? "Work finished with issues" : "Work completed";
  return <section className={`work-log ${running ? "active" : hasError ? "error" : "complete"}`} aria-live="polite">
    <button className="work-log-summary" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span className="work-log-orb">{running && !waiting ? <LoaderCircle className="spin" /> : hasError ? <AlertCircle /> : <CircleCheck />}</span>
      <span><strong>{heading}</strong><small>{activities.length ? `${activities.length} ${activities.length === 1 ? "activity" : "activities"}` : "Preparing the first step"}</small></span>
      {expanded ? <ChevronUp /> : <ChevronDown />}
    </button>
    {expanded && (activities.length > 0 ? <div className="work-log-list">{activities.map((item) => <WorkItem key={item.id} item={item} />)}</div> : running ? <div className="work-log-pending"><i /><i /><i /><span>Waiting for activity details…</span></div> : null)}
  </section>;
}

function lastRunningTitle(activities: WorkActivity[]): string | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]?.status === "running") return activities[index]?.title;
  }
  return undefined;
}

function WorkItem({ item }: { item: WorkActivity }) {
  const [open, setOpen] = useState(item.status === "running");
  const hasDetails = Boolean(item.detail || item.context);
  useEffect(() => { if (item.status === "running") setOpen(true); }, [item.status]);
  return <div className={`work-item ${item.status}`}>
    <button type="button" className="work-item-heading" onClick={() => hasDetails && setOpen((value) => !value)} aria-expanded={hasDetails ? open : undefined}>
      <span className="work-item-icon">{workIcon(item)}</span>
      <span className="work-item-title">{item.title}</span>
      {hasDetails && (open ? <ChevronUp className="work-item-chevron" /> : <ChevronDown className="work-item-chevron" />)}
      <span className="work-item-state">{item.status === "running" ? <LoaderCircle className="spin" /> : item.status === "error" ? <AlertCircle /> : <Check />}</span>
    </button>
    {open && hasDetails && <div className="work-item-details">{item.detail && <code>{item.detail}</code>}{item.context && <pre>{item.context}</pre>}</div>}
  </div>;
}

function workIcon(item: WorkActivity) {
  if (item.kind === "thinking") return <BrainCircuit />;
  if (item.kind === "search") return <Search />;
  if (item.kind === "edit") return <FilePenLine />;
  if (item.kind === "tool") return <Code2 />;
  if (item.kind === "error") return <AlertCircle />;
  return <Terminal />;
}

function PendingCard({ pending, disabled, onResolve }: { pending: TaskWorkspace["pendingRequests"][number]; disabled: boolean; onResolve: (body: { approved?: boolean; answers?: Record<string, string> }) => void }) {
  if (pending.requestType === "user_input") {
    const questions = Array.isArray(pending.payload.questions) ? pending.payload.questions as Array<Record<string, unknown>> : [];
    return <form className="pending-card" onSubmit={(event) => {
      event.preventDefault();
      if (disabled) return;
      const data = new FormData(event.currentTarget);
      onResolve({ answers: Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value)])) });
    }}><strong>Codex needs clarification</strong>{questions.map((question, index) => {
      const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
      return <label key={String(question.id ?? index)}>{String(question.question ?? question.header ?? "Answer")}{options.length ? <select name={String(question.id ?? index)} required defaultValue=""><option value="" disabled>Choose…</option>{options.map((option) => <option key={String(option.label)} value={String(option.label)}>{String(option.label)}</option>)}</select> : <input name={String(question.id ?? index)} required />}</label>;
    })}<button className="primary" type="submit" disabled={disabled}>Send answers</button></form>;
  }
  return <div className="pending-card"><strong>Approval requested</strong><p>{String(pending.payload.reason ?? pending.payload.command ?? pending.payload.method ?? "Codex requested permission to continue.")}</p><div className="button-row"><button className="secondary" type="button" disabled={disabled} onClick={() => onResolve({ approved: false })}>Deny</button><button className="primary" type="button" disabled={disabled} onClick={() => onResolve({ approved: true })}>Approve once</button></div></div>;
}
