import { Link2, ListTodo, MonitorSmartphone, Network, Plus, Settings2, WifiOff } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { Project, TaskSummary } from "../domain/types";
import { api, connection, type ConnectionState } from "./api";
import { TaskCard } from "./components/TaskCard";
import { SessionWorkspace } from "./components/SessionWorkspace";
import { ProjectLogo } from "./components/ProjectLogo";
import { preferredCreateProjectId, readLastCreateProjectId, writeLastCreateProjectId } from "./project-preference";

const CreateTask = lazy(() => import("./components/CreateTask").then((module) => ({ default: module.CreateTask })));
const ProjectManager = lazy(() => import("./components/ProjectManager").then((module) => ({ default: module.ProjectManager })));

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

  return <div className="app-shell unified-shell">
    <header className="app-header unified-header">
      <div className="brand"><span>✓</span><div><strong>Qahwa</strong><small>{tasks.filter((task) => task.sessionState === "running").length} working · {tasks.length} shown</small></div></div>
      <button type="button" className="icon-button connection-indicator" onClick={() => {
        if (window.confirm("Disconnect this browser from Qahwa?")) connection.disconnect();
      }} aria-label="Computer connected"><MonitorSmartphone /></button>
      {view === "tasks" && <><button type="button" className="icon-button" onClick={() => setShowProjects(true)} aria-label="Manage projects"><Settings2 /></button>
        <div className="project-filter">{selectedProject && <ProjectLogo logo={selectedProject.logo} prefix={selectedProject.prefix} size="small" />}
          <select aria-label="Filter by project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">All projects</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        </div></>}
    </header>
    {offline && <div className="offline-banner"><WifiOff />Offline · showing cached content</div>}

    {view === "tasks" ? <main className="unified-task-list">
      <div className="list-controls"><div className="scope-tabs">{(["all", "active", "closed"] as Scope[]).map((value) => <button type="button" key={value} className={scope === value ? "active" : ""} onClick={() => setScope(value)}>{value}</button>)}</div><span>{tasks.length} tasks</span></div>
      <div className="task-rows">{tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => openTask(task)} />)}</div>
      {tasks.length === 0 && <div className="empty-state"><span>✓</span><p>No tasks in this view.</p></div>}
    </main> : <SessionWorkspace mode="orchestrator" onError={fail} onChanged={() => void loadTasks()} />}

    {view === "tasks" && activeProjects.length > 0 && <button type="button" className="fab" onClick={() => setShowCreate(true)}><Plus /><span>Add task</span></button>}
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
  if (state === "connecting") return <main className="connection-screen"><div className="connection-card"><div className="coffee-mark">✓</div><h1>Connecting to your computer</h1><p>Your task workspace will open after the secure connection is ready.</p></div></main>;
  if (state === "offline" && profile) return <main className="connection-screen"><div className="connection-card"><div className="coffee-mark">✓</div><h1>Computer unavailable</h1><p>Qahwa will keep reconnecting securely to the paired computer.</p><button className="primary" disabled={busy} onClick={() => {
    setBusy(true);
    void connection.connect().catch((error) => onError(error instanceof Error ? error.message : "Could not reconnect")).finally(() => setBusy(false));
  }}><MonitorSmartphone /> Reconnect</button><button className="secondary" onClick={() => connection.disconnect()}>Forget this computer</button></div></main>;
  return <main className="connection-screen"><form className="connection-card" onSubmit={(event) => {
    event.preventDefault();
    setBusy(true);
    void connection.pair(pairingLink.trim()).catch((error) => onError(error instanceof Error ? error.message : "Pairing failed")).finally(() => setBusy(false));
  }}><div className="coffee-mark">✓</div><h1>Connect your Qahwa server</h1><p>Paste the one-time pairing link created by the Qahwa Tasks server on your computer.</p><textarea autoFocus required rows={5} value={pairingLink} onChange={(event) => setPairingLink(event.target.value)} placeholder="qahwa://pair?endpoint=…" /><button className="primary" disabled={busy || !pairingLink.trim()} type="submit"><Link2 />{busy ? "Pairing…" : "Pair securely"}</button><small>The server identity and this browser’s unique device key remain pinned for automatic reconnection.</small></form></main>;
}

function taskFromPath(): string | null {
  const match = window.location.pathname.match(/^\/tasks\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}
