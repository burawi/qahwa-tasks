import { Archive, ArrowLeft, Check, ChevronDown, Link2, ListTodo, MonitorSmartphone, Plus, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Project, SelectedTaskReference, TaskSummary } from "../domain/types";
import { api, connection, type ConnectionState } from "./api";
import { TaskCard } from "./components/TaskCard";
import { RunningIndicator } from "./components/RunningIndicator";
import { ProjectLogo } from "./components/ProjectLogo";
import { preferredCreateProjectId, readLastCreateProjectId, writeLastCreateProjectId } from "./project-preference";
import { useChatReadState } from "./use-chat-read-state";
import { readTaskSelection, taskSelectionKey, toggleTaskSelection, writeTaskSelection } from "./task-selection";
import { TaskSelection } from "./components/TaskSelection";
import { useOrchestratorSettings } from "./use-orchestrator-settings";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "../domain/orchestrator-settings";
import { UserAvatarProvider } from "./user-avatar";
import { OrchestratorAvatarProvider } from "./orchestrator-avatar";
import { OrchestratorAvatar } from "./components/OrchestratorAvatar";
import { BrandMark } from "./components/BrandMark";
import { ActionDialog } from "./components/ActionDialog";
import { taskIdFromPath } from "./message-resource";
import { normalizeTaskSearch, searchTasks } from "./task-search";
import { CodexUsageProvider } from "./codex-usage";
import { CodexUsageIndicator } from "./components/CodexUsageIndicator";

const CreateTask = lazy(() => import("./components/CreateTask").then((module) => ({ default: module.CreateTask })));
const ProjectManager = lazy(() => import("./components/ProjectManager").then((module) => ({ default: module.ProjectManager })));
const SessionWorkspace = lazy(() => import("./components/SessionWorkspace").then((module) => ({ default: module.SessionWorkspace })));
const TaskChat = lazy(() => import("./components/TaskChat").then(module => ({ default: module.TaskChat })));

type View = "tasks" | "orchestrator";
type Scope = "active" | "closed";
const orchestratorReads = {
  load: () => api.orchestratorUnread(),
  acknowledge: (ids: string[]) => api.markOrchestratorRead(ids),
};

export function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>(connection.state());
  const [workspaceOpened, setWorkspaceOpened] = useState(connection.state() === "online");
  const [view, setView] = useState<View>(() => window.location.pathname === "/orchestrator" ? "orchestrator" : "tasks");
  const [scope, setScope] = useState<Scope>("active");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const taskListScope = useRef("");
  taskListScope.current = JSON.stringify([scope, projectId]);
  const taskListRequest = useRef(0);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const profile = connection.profile();
  const selectionKey = taskSelectionKey(profile?.serverPublicKey, profile?.deviceId);
  const [selection, setSelection] = useState(() => ({ key: selectionKey, tasks: readTaskSelection(selectionKey) }));
  const selectedTasks = selection.key === selectionKey ? selection.tasks : [];
  useEffect(() => {
    if (selection.key !== selectionKey) setSelection({ key: selectionKey, tasks: readTaskSelection(selectionKey) });
    else writeTaskSelection(selectionKey, selection.tasks);
  }, [selectionKey, selection]);
  const toggleSelection = (task: SelectedTaskReference) => setSelection((current) => ({ key: selectionKey,
    tasks: toggleTaskSelection(current.key === selectionKey ? current.tasks : [], task) }));
  const clearSelection = () => setSelection({ key: selectionKey, tasks: [] });
  const [selectedTask, setSelectedTask] = useState<string | null>(() => taskFromPath());
  const [showCreate, setShowCreate] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showUsageDetails, setShowUsageDetails] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [lastCreateProjectId, setLastCreateProjectId] = useState(() => readLastCreateProjectId());
  const [toast, setToast] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const connected = connectionState === "online" && !offline;
  const indicatorState = connected ? "connected" : !offline && connectionState === "connecting" ? "reconnecting" : "offline";
  const connectionLabel = connected ? "Computer connected" : offline ? "Offline" : connectionState === "connecting" ? "Computer reconnecting" : "Computer unavailable";
  const connectionDescription = `${connectionLabel}. Disconnect this browser from Qahwa.`;
  const orchestratorPreferences = useOrchestratorSettings(connected, profile?.serverPublicKey ?? "");
  const orchestratorName = orchestratorPreferences.settings?.name ?? DEFAULT_ORCHESTRATOR_SETTINGS.name;
  const orchestratorReadState = useChatReadState(orchestratorReads, connectionState === "online" && !offline,
    view === "orchestrator", view === "orchestrator" && !selectedTask && !showProjects && !showCreate);

  const fail = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 4500); };
  const handleError = (error: unknown) => fail(error instanceof Error ? error.message : "Something went wrong");
  const loadProjects = async () => setProjects((await api.projects()).projects);
  const loadTasks = async () => {
    const requestedScope = JSON.stringify([scope, projectId]);
    if (requestedScope !== taskListScope.current) return;
    const request = ++taskListRequest.current;
    const next = (await api.tasks(scope, projectId || undefined)).tasks;
    if (requestedScope !== taskListScope.current || request !== taskListRequest.current) return;
    setTasks((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  };
  const refresh = async () => Promise.all([loadProjects(), loadTasks()]);
  const pinSelected = async (pinned: boolean) => {
    if (!connected || pinBusy) return;
    setPinBusy(true);
    try { await Promise.all(selectedTasks.map((task) => api.setTaskPinned(task.id, pinned))); }
    catch (error) { handleError(error); }
    finally {
      await loadTasks().catch(handleError);
      setPinBusy(false);
    }
  };

  useEffect(() => {
    const unsubscribe = connection.subscribe((state) => {
      setConnectionState(state);
      if (state === "online") setWorkspaceOpened(true);
      else if (state === "unpaired") {
        setWorkspaceOpened(false);
        setProjects([]);
        setTasks([]);
        setShowCreate(false);
        setShowProjects(false);
      }
    });
    void connection.connect().catch(() => undefined);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (connectionState !== "online" || offline) return;
    void refresh().catch(handleError);
    const timer = window.setInterval(() => void loadTasks().catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [connectionState, offline, scope, projectId]);
  useEffect(() => {
    const online = () => setOffline(false); const offlineHandler = () => setOffline(true);
    const pop = () => { setSelectedTask(taskFromPath()); setView(window.location.pathname === "/orchestrator" ? "orchestrator" : "tasks"); };
    window.addEventListener("online", online); window.addEventListener("offline", offlineHandler); window.addEventListener("popstate", pop);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offlineHandler); window.removeEventListener("popstate", pop); };
  }, []);
  useEffect(() => {
    if (projectId && projects.length && !projects.some((project) => project.id === projectId && !project.archivedAt)) setProjectId("");
    if (lastCreateProjectId && projects.length && !projects.some((project) => project.id === lastCreateProjectId && !project.archivedAt)) {
      writeLastCreateProjectId(); setLastCreateProjectId(undefined);
    }
  }, [projectId, lastCreateProjectId, projects]);

  if (connectionState === "unpaired" || (!workspaceOpened && connectionState !== "online")) return <ConnectionScreen state={connectionState} onError={fail} />;

  const activeProjects = projects.filter((project) => !project.archivedAt);
  const searching = Boolean(normalizeTaskSearch(search));
  const scopedTasks = tasks.filter(task => (!projectId || task.projectId === projectId) && (scope === "closed" ? task.status === "closed" : task.status !== "closed"));
  const visibleTasks = searchTasks(scopedTasks, search);
  const clearSearch = () => { setSearch(""); searchInput.current?.focus(); };
  const closeSearch = () => { setSearch(""); setShowSearch(false); searchToggle.current?.focus(); };
  const selectedProject = activeProjects.find((project) => project.id === projectId);
  const openTask = (task: TaskSummary) => { history.pushState({}, "", `/tasks/${task.humanId}`); setView("tasks"); setSelectedTask(task.humanId); };
  const selectView = (next: View) => { history.pushState({}, "", next === "orchestrator" ? "/orchestrator" : "/"); setSelectedTask(null); setView(next); };

  return <UserAvatarProvider key={profile?.serverPublicKey ?? ""} connected={connected}><OrchestratorAvatarProvider connected={connected}><CodexUsageProvider connected={connected} onOpenDetails={() => { setShowUsageDetails(true); setShowProjects(true); }}><div className="app-shell unified-shell">
    <header className="app-header unified-header">
      <button type="button" className="brand" onClick={() => selectView("tasks")} aria-label="Qahwa Tasks home"><BrandMark /><div><strong>Qahwa</strong><small>Tasks</small></div></button>
      <nav className="desktop-tabs" aria-label="Main navigation">
        <button type="button" className={view === "tasks" ? "active" : ""} onClick={() => selectView("tasks")}><ListTodo />Tasks</button>
        <button type="button" className={view === "orchestrator" ? "active" : ""} onClick={() => selectView("orchestrator")}><OrchestratorAvatar /><span className="orchestrator-name" title={orchestratorName}>{orchestratorName}</span><RunningIndicator running={orchestratorReadState.sessionState === "running"} label={`${orchestratorName} running`} /><UnreadBadge count={orchestratorReadState.unreadCount} /></button>
      </nav>
      <div className="header-actions">
      <CodexUsageIndicator />
      <button type="button" className="icon-button connection-indicator" data-state={indicatorState} onClick={() => {
        setDisconnecting(true);
      }} aria-label={connectionDescription} title={connectionDescription}><span className="live-dot" aria-hidden="true" /><MonitorSmartphone aria-hidden="true" /></button>
      <button type="button" className="icon-button" onClick={() => setShowProjects(true)} aria-label="Projects and settings"><Settings2 /></button>
      </div>
    </header>
    {view === "tasks" ? <main className="unified-task-list">
      <div className="workspace-intro" data-qahwa-id="workspace-intro"><span className="workspace-eyebrow">A little clarity. A lot of possibility.</span><h1>{scope === "closed" ? "Completed work" : "Your workspace"}</h1><p>{scope === "closed" ? "A home for everything you have moved forward." : "Ideas, conversations, and work in motion."}</p></div>
      <section className="task-toolbar" aria-label="Task filters">
        <div className="project-filter" data-qahwa-id="project-filter"><div className="project-choice">{selectedProject && <ProjectLogo logo={selectedProject.logo} prefix={selectedProject.prefix} size="small" />}
          <select aria-label="Filter by project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">All projects</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown aria-hidden="true" />
        </div>
        <button type="button" className={`archive-toggle${scope === "closed" ? " active" : ""}`} onClick={() => setScope(scope === "closed" ? "active" : "closed")} aria-label={scope === "closed" ? "Return to active tasks" : "Open completed task history"} title={scope === "closed" ? "Back to tasks" : "Completed task history"}>{scope === "closed" ? <ArrowLeft /> : <Archive />}<span>{scope === "closed" ? "Tasks" : "History"}</span></button>
        <span className="task-count" role="status">{searching ? `${visibleTasks.length} of ${scopedTasks.length}` : scopedTasks.length} {scope === "closed" ? "completed" : scopedTasks.length === 1 ? "task" : "tasks"}</span>
        <button ref={searchToggle} type="button" className="icon-button task-search-toggle" aria-label={showSearch ? "Hide search" : "Show search"} title={showSearch ? "Hide search" : "Search tasks and sessions"} aria-expanded={showSearch} aria-controls="task-search" onClick={() => { if (showSearch) closeSearch(); else setShowSearch(true); }}><Search aria-hidden="true" /></button>
        </div>
        {activeProjects.length > 0 && <button type="button" className="primary desktop-create" onClick={() => setShowCreate(true)}><Plus />New task</button>}
      </section>
      {showSearch && <div id="task-search" className="task-search" role="search" aria-label="Tasks and sessions">
        <Search aria-hidden="true" />
        <input ref={searchInput} autoFocus type="search" aria-label="Search tasks and sessions" placeholder="Search tasks and sessions" value={search}
          onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); if (search) clearSearch(); else closeSearch(); } }} />
        {search && <button type="button" className="icon-button" aria-label="Clear search" onClick={clearSearch}><X aria-hidden="true" /></button>}
      </div>}
      {selectedTasks.length > 0 && <TaskSelection orchestratorName={orchestratorName} tasks={selectedTasks} onClear={clearSelection} onRemove={toggleSelection} onDiscuss={() => selectView("orchestrator")} onPin={(pinned) => void pinSelected(pinned)} pinDisabled={!connected || pinBusy} />}
      <div className="task-rows">{visibleTasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => openTask(task)} selectionMode={selectedTasks.length > 0} selected={selectedTasks.some(({ id }) => id === task.id)} onToggleSelection={() => toggleSelection(task)} />)}</div>
      {visibleTasks.length === 0 && (searching ? <div className="empty-state refined-empty"><span><Search /></span><h2>No matching tasks or sessions</h2><p>Try another title, task ID, project name, or description. Searching {scope === "closed" ? "completed history" : "active tasks"} in {selectedProject?.name ?? "all projects"}.</p><button type="button" className="secondary" onClick={clearSearch}>Clear search</button></div> : <div className="empty-state refined-empty"><span><Check /></span><h2>{scope === "closed" ? "No completed tasks" : !projectId ? "A clear workspace" : "Nothing here yet"}</h2><p>{scope === "closed" ? "Completed work will stay quietly available here." : !projectId ? "Add a quick note. Its session will help shape the work when you start it." : "No tasks match this project."}</p>{scope === "active" && activeProjects.length > 0 && <button type="button" className="primary" onClick={() => setShowCreate(true)}><Plus />Create your first task</button>}</div>)}
    </main> : <Suspense fallback={<div className="screen-loading">Loading session…</div>}><SessionWorkspace mode="orchestrator" orchestratorName={orchestratorName} connected={connected} selectedTasks={selectedTasks} onClearTaskSelection={clearSelection} onRemoveTaskSelection={toggleSelection} highlightedMessageIds={orchestratorReadState.highlightedIds} onMessagesLoaded={orchestratorReadState.onMessagesLoaded} onError={fail} onChanged={() => void loadTasks()} /></Suspense>}

    {view === "tasks" && activeProjects.length > 0 && <button type="button" className="fab" aria-label="New task" title="New task" data-qahwa-id="fab" onClick={() => setShowCreate(true)}><Plus aria-hidden="true" /></button>}
    <nav className="bottom-tabs two-tabs" aria-label="Main navigation" data-qahwa-id="bottom-tabs"><button type="button" className={view === "tasks" ? "active" : ""} aria-current={view === "tasks" ? "page" : undefined} onClick={() => selectView("tasks")}><ListTodo /><span>Tasks</span></button><button type="button" className={view === "orchestrator" ? "active" : ""} aria-current={view === "orchestrator" ? "page" : undefined} onClick={() => selectView("orchestrator")}><OrchestratorAvatar /><span className="orchestrator-name" title={orchestratorName}>{orchestratorName}</span><RunningIndicator running={orchestratorReadState.sessionState === "running"} label={`${orchestratorName} running`} /><UnreadBadge count={orchestratorReadState.unreadCount} /></button></nav>

    <Suspense fallback={<div className="screen-loading">Loading…</div>}>
      {showCreate && <CreateTask connected={connected} projects={activeProjects} initialProjectId={preferredCreateProjectId(activeProjects, lastCreateProjectId, projectId)} onCancel={() => setShowCreate(false)} onProjectChange={(id) => { writeLastCreateProjectId(id); setLastCreateProjectId(id); }} onSave={async (value) => {
        try { const created = await api.createTask(value); writeLastCreateProjectId(value.projectId); setLastCreateProjectId(value.projectId); setShowCreate(false); setScope("active"); await loadTasks(); window.setTimeout(() => document.querySelector(`[data-task-id="${created.task.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80); }
        catch (error) { handleError(error); throw error; }
      }} onTerminal={async (projectId, creationKey) => {
        const { task } = await api.createTerminal(projectId, creationKey);
        writeLastCreateProjectId(projectId); setLastCreateProjectId(projectId);
        setShowCreate(false); setScope("active"); openTask(task);
        void loadTasks().catch(handleError);
      }} />}
      {selectedTask && <TaskChat key={selectedTask} connected={connected} foreground={!showCreate && !showProjects} taskId={selectedTask} onClearTaskSelection={clearSelection} onClose={() => { history.pushState({}, "", "/"); setSelectedTask(null); if (connected) void loadTasks().catch(() => undefined); }} onChanged={() => void loadTasks()} onError={fail} />}
      {showProjects && <ProjectManager focusUsage={showUsageDetails} orchestratorSettings={orchestratorPreferences.settings} settingsError={orchestratorPreferences.error} connected={connected} onSettingsSaved={orchestratorPreferences.accept} onClose={() => { setShowProjects(false); setShowUsageDetails(false); }} onChanged={() => void refresh()} onError={fail} />}
    </Suspense>
    {disconnecting && <ActionDialog title="Disconnect this browser?" description="Disconnect this browser from Qahwa? You will need a new pairing link to reconnect."
      confirmLabel="Disconnect" destructive onConfirm={() => connection.disconnect()} onClose={() => setDisconnecting(false)} />}
    {toast && <div className="toast">{toast}</div>}
  </div></CodexUsageProvider></OrchestratorAvatarProvider></UserAvatarProvider>;
}

function UnreadBadge({ count }: { count: number }) {
  return count > 0 ? <span className="unread-badge" role="status" aria-label={`${count} unread ${count === 1 ? "message" : "messages"}`}>{count}</span> : null;
}

function ConnectionScreen({ state, onError }: { state: ConnectionState; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [pairingLink, setPairingLink] = useState("");
  const profile = connection.profile();
  if (state === "connecting") return <main className="connection-screen"><div className="connection-card"><BrandMark large /><div className="connection-progress"><i /><i /><i /></div><h1>Connecting securely</h1><p>Your private workspace will open as soon as your computer responds.</p></div></main>;
  if (state === "offline" && profile) return <main className="connection-screen"><div className="connection-card"><BrandMark large /><span className="connection-kicker">Paired device</span><h1>Computer unavailable</h1><p>Qahwa will reconnect automatically. Your device identity is still safely paired.</p><button className="primary" disabled={busy} onClick={() => {
    setBusy(true);
    void connection.connect().catch((error) => onError(error instanceof Error ? error.message : "Could not reconnect")).finally(() => setBusy(false));
  }}><MonitorSmartphone /> Reconnect</button><button className="secondary" onClick={() => connection.disconnect()}>Forget this computer</button></div></main>;
  return <main className="connection-screen"><form className="connection-card" onSubmit={(event) => {
    event.preventDefault();
    setBusy(true);
    void connection.pair(pairingLink.trim()).catch((error) => onError(error instanceof Error ? error.message : "Pairing failed")).finally(() => setBusy(false));
  }}><BrandMark large /><span className="connection-kicker"><ShieldCheck />Private by design</span><h1>Pair with your Qahwa server</h1><p>Generate a one-time link on your computer, then paste it below. You only need to do this once.</p><label>One-time pairing link<textarea autoFocus required rows={4} value={pairingLink} onChange={(event) => setPairingLink(event.target.value)} placeholder="qahwa://pair?endpoint=…" /></label><button className="primary" disabled={busy || !pairingLink.trim()} type="submit"><Link2 />{busy ? "Pairing securely…" : "Pair this device"}</button><small><ShieldCheck /> End-to-end encrypted · server identity pinned to this device</small></form></main>;
}

function taskFromPath(): string | null {
  return taskIdFromPath(window.location.pathname);
}
