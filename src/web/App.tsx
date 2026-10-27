import { Check, ChevronDown, Link2, ListTodo, MonitorSmartphone, Network, Plus, Settings2, ShieldCheck, WifiOff } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { Project, TaskSummary } from "../domain/types";
import { api, connection, type ConnectionState } from "./api";
import { TaskCard } from "./components/TaskCard";
import { ProjectLogo } from "./components/ProjectLogo";
import { preferredCreateProjectId, readLastCreateProjectId, writeLastCreateProjectId } from "./project-preference";

const CreateTask = lazy(() => import("./components/CreateTask").then((module) => ({ default: module.CreateTask })));
const ProjectManager = lazy(() => import("./components/ProjectManager").then((module) => ({ default: module.ProjectManager })));
const SessionWorkspace = lazy(() => import("./components/SessionWorkspace").then((module) => ({ default: module.SessionWorkspace })));

type View = "tasks" | "orchestrator";
type Scope = "all" | "active" | "closed";

export function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>(connection.state());
  const [view, setView] = useState<View>(() => window.location.pathname === "/orchestrator" ? "orchestrator" : "tasks");
  const [scope, setScope] = useState<Scope>("all");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(() => taskFromPath());
  const [showCreate, setShowCreate] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [lastCreateProjectId, setLastCreateProjectId] = useState(() => readLastCreateProjectId());
  const [toast, setToast] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);

  const fail = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 4500); };
  const handleError = (error: unknown) => fail(error instanceof Error ? error.message : "Something went wrong");
  const loadProjects = async () => setProjects((await api.projects()).projects);
  const loadTasks = async () => setTasks((await api.tasks(scope, projectId || undefined)).tasks);
  const refresh = async () => Promise.all([loadProjects(), loadTasks()]);

  useEffect(() => {
    const unsubscribe = connection.subscribe(setConnectionState);
    void connection.connect().catch(() => undefined);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (connectionState !== "online") return;
    void refresh().catch(handleError);
    const timer = window.setInterval(() => void loadTasks().catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [connectionState, scope, projectId]);
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

  if (connectionState !== "online") return <ConnectionScreen state={connectionState} onError={fail} />;

  const activeProjects = projects.filter((project) => !project.archivedAt);
  const selectedProject = activeProjects.find((project) => project.id === projectId);
  const openTask = (task: TaskSummary) => { history.pushState({}, "", `/tasks/${task.humanId}`); setView("tasks"); setSelectedTask(task.humanId); };
  const selectView = (next: View) => { history.pushState({}, "", next === "orchestrator" ? "/orchestrator" : "/"); setSelectedTask(null); setView(next); };

  const workingCount = tasks.filter((task) => task.sessionState === "running").length;
  return <div className="app-shell unified-shell">
    <header className="app-header unified-header">
      <button type="button" className="brand" onClick={() => selectView("tasks")} aria-label="Qahwa Tasks home"><span>Q</span><div><strong>Qahwa</strong><small>Tasks</small></div></button>
      <nav className="desktop-tabs" aria-label="Main navigation">
        <button type="button" className={view === "tasks" ? "active" : ""} onClick={() => selectView("tasks")}><ListTodo />Tasks</button>
        <button type="button" className={view === "orchestrator" ? "active" : ""} onClick={() => selectView("orchestrator")}><Network />Orchestrator</button>
      </nav>
      <div className="header-actions">
      <button type="button" className="icon-button connection-indicator" onClick={() => {
        if (window.confirm("Disconnect this browser from Qahwa?")) connection.disconnect();
      }} aria-label="Computer connected"><span className="live-dot" /><MonitorSmartphone /></button>
      <button type="button" className="icon-button" onClick={() => setShowProjects(true)} aria-label="Projects and settings"><Settings2 /></button>
      </div>
    </header>
    {offline && <div className="offline-banner"><WifiOff />Offline · showing cached content</div>}

    {view === "tasks" ? <main className="unified-task-list">
      <section className="tasks-heading">
        <div><p className="eyebrow">Workspace</p><h1>{selectedProject?.name ?? "All tasks"}</h1><p>{workingCount ? `${workingCount} ${workingCount === 1 ? "session is" : "sessions are"} working now` : "Capture work, then start it when you are ready."}</p></div>
        {activeProjects.length > 0 && <button type="button" className="primary desktop-create" onClick={() => setShowCreate(true)}><Plus />New task</button>}
      </section>
      <section className="task-toolbar" aria-label="Task filters">
        <div className="project-filter">{selectedProject && <ProjectLogo logo={selectedProject.logo} prefix={selectedProject.prefix} size="small" />}
          <select aria-label="Filter by project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">All projects</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown />
        </div>
        <div className="scope-tabs">{(["all", "active", "closed"] as Scope[]).map((value) => <button type="button" key={value} className={scope === value ? "active" : ""} onClick={() => setScope(value)}>{value}</button>)}</div>
        <span className="task-count">{tasks.length} {tasks.length === 1 ? "task" : "tasks"}</span>
      </section>
      <div className="task-rows">{tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => openTask(task)} />)}</div>
      {tasks.length === 0 && <div className="empty-state refined-empty"><span><Check /></span><h2>{scope === "all" && !projectId ? "A clear workspace" : "Nothing here yet"}</h2><p>{scope === "all" && !projectId ? "Add a quick note. Its session will help shape the work when you start it." : "No tasks match these filters."}</p>{scope === "all" && activeProjects.length > 0 && <button type="button" className="primary" onClick={() => setShowCreate(true)}><Plus />Create your first task</button>}</div>}
    </main> : <Suspense fallback={<div className="screen-loading">Loading session…</div>}><SessionWorkspace mode="orchestrator" onError={fail} onChanged={() => void loadTasks()} /></Suspense>}

    {view === "tasks" && activeProjects.length > 0 && <button type="button" className="fab" onClick={() => setShowCreate(true)}><Plus /><span>New task</span></button>}
    <nav className="bottom-tabs two-tabs"><button type="button" className={view === "tasks" ? "active" : ""} onClick={() => selectView("tasks")}><ListTodo /><span>Tasks</span></button><button type="button" className={view === "orchestrator" ? "active" : ""} onClick={() => selectView("orchestrator")}><Network /><span>Orchestrator</span></button></nav>

    <Suspense fallback={<div className="screen-loading">Loading…</div>}>
      {showCreate && <CreateTask projects={activeProjects} initialProjectId={preferredCreateProjectId(activeProjects, lastCreateProjectId, projectId)} onCancel={() => setShowCreate(false)} onProjectChange={(id) => { writeLastCreateProjectId(id); setLastCreateProjectId(id); }} onSave={async (value) => {
        try { const created = await api.createTask(value); writeLastCreateProjectId(value.projectId); setLastCreateProjectId(value.projectId); setShowCreate(false); setScope("all"); await loadTasks(); window.setTimeout(() => document.querySelector(`[data-task-id="${created.task.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80); }
        catch (error) { handleError(error); }
      }} />}
      {showProjects && <ProjectManager onClose={() => setShowProjects(false)} onChanged={() => void refresh()} onError={fail} />}
      {selectedTask && <SessionWorkspace mode="task" taskId={selectedTask} onClose={() => { history.pushState({}, "", "/"); setSelectedTask(null); }} onNavigateTask={(humanId) => {
        history.pushState({}, "", `/tasks/${humanId}`);
        setSelectedTask(humanId);
      }} onChanged={() => void loadTasks()} onError={fail} />}
    </Suspense>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function ConnectionScreen({ state, onError }: { state: ConnectionState; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [pairingLink, setPairingLink] = useState("");
  const profile = connection.profile();
  if (state === "connecting") return <main className="connection-screen"><div className="connection-card"><div className="coffee-mark">Q</div><div className="connection-progress"><i /><i /><i /></div><h1>Connecting securely</h1><p>Your private workspace will open as soon as your computer responds.</p></div></main>;
  if (state === "offline" && profile) return <main className="connection-screen"><div className="connection-card"><div className="coffee-mark">Q</div><span className="connection-kicker">Paired device</span><h1>Computer unavailable</h1><p>Qahwa will reconnect automatically. Your device identity is still safely paired.</p><button className="primary" disabled={busy} onClick={() => {
    setBusy(true);
    void connection.connect().catch((error) => onError(error instanceof Error ? error.message : "Could not reconnect")).finally(() => setBusy(false));
  }}><MonitorSmartphone /> Reconnect</button><button className="secondary" onClick={() => connection.disconnect()}>Forget this computer</button></div></main>;
  return <main className="connection-screen"><form className="connection-card" onSubmit={(event) => {
    event.preventDefault();
    setBusy(true);
    void connection.pair(pairingLink.trim()).catch((error) => onError(error instanceof Error ? error.message : "Pairing failed")).finally(() => setBusy(false));
  }}><div className="coffee-mark">Q</div><span className="connection-kicker"><ShieldCheck />Private by design</span><h1>Pair with your Qahwa server</h1><p>Generate a one-time link on your computer, then paste it below. You only need to do this once.</p><label>One-time pairing link<textarea autoFocus required rows={4} value={pairingLink} onChange={(event) => setPairingLink(event.target.value)} placeholder="qahwa://pair?endpoint=…" /></label><button className="primary" disabled={busy || !pairingLink.trim()} type="submit"><Link2 />{busy ? "Pairing securely…" : "Pair this device"}</button><small><ShieldCheck /> End-to-end encrypted · server identity pinned to this device</small></form></main>;
}

function taskFromPath(): string | null {
  const match = window.location.pathname.match(/^\/tasks\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}
