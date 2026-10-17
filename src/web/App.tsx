import { closestCenter, DndContext, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Archive, CheckCircle2, CircleDot, ClipboardList, LogOut, Plus, Settings2, WifiOff } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { Project, TaskSummary } from "../domain/types";
import { api, ApiError } from "./api";
import { TaskCard } from "./components/TaskCard";

const CreateTask = lazy(() => import("./components/CreateTask").then((module) => ({ default: module.CreateTask })));
const ProjectManager = lazy(() => import("./components/ProjectManager").then((module) => ({ default: module.ProjectManager })));
const TaskDetail = lazy(() => import("./components/TaskDetail").then((module) => ({ default: module.TaskDetail })));

type Tab = "backlog" | "todo" | "open" | "closed";
const TABS: Array<{ id: Tab; label: string; icon: typeof Archive }> = [
  { id: "backlog", label: "Backlog", icon: Archive },
  { id: "todo", label: "Todo", icon: ClipboardList },
  { id: "open", label: "Open", icon: CircleDot },
  { id: "closed", label: "Closed", icon: CheckCircle2 },
];

export function App() {
  const [auth, setAuth] = useState<{ loading: boolean; authenticated: boolean; configured: boolean }>({ loading: true, authenticated: false, configured: true });
  const [tab, setTab] = useState<Tab>("backlog");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [counts, setCounts] = useState<Record<Tab, number>>({ backlog: 0, todo: 0, open: 0, closed: 0 });
  const [selectedTask, setSelectedTask] = useState<string | null>(() => taskFromPath());
  const [showCreate, setShowCreate] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [toast, setToast] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }));

  const fail = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 4000); };
  const loadProjects = async () => setProjects((await api.projects()).projects);
  const loadTasks = async () => {
    const entries = await Promise.all(TABS.map(async ({ id }) => [id, (await api.tasks(id, projectId || undefined)).tasks] as const));
    const mapping = Object.fromEntries(entries) as Record<Tab, TaskSummary[]>;
    setTasks(mapping[tab]);
    setCounts(Object.fromEntries(entries.map(([id, values]) => [id, values.length])) as Record<Tab, number>);
  };
  const refresh = async () => { await Promise.all([loadProjects(), loadTasks()]); };

  useEffect(() => { void api.authState().then((state) => setAuth({ loading: false, ...state })).catch(() => setAuth({ loading: false, authenticated: false, configured: true })); }, []);
  useEffect(() => { if (auth.authenticated) void refresh().catch(handleAuthError); }, [auth.authenticated, tab, projectId]);
  useEffect(() => {
    if (projectId && projects.length > 0 && !projects.some((project) => project.id === projectId && !project.archivedAt)) setProjectId("");
  }, [projectId, projects]);
  useEffect(() => {
    const online = () => setOffline(false); const offlineHandler = () => setOffline(true);
    window.addEventListener("online", online); window.addEventListener("offline", offlineHandler);
    const pop = () => setSelectedTask(taskFromPath()); window.addEventListener("popstate", pop);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offlineHandler); window.removeEventListener("popstate", pop); };
  }, []);

  const handleAuthError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) setAuth((value) => ({ ...value, authenticated: false }));
    else fail(error instanceof Error ? error.message : "Could not load tasks");
  };
  const openTask = (task: TaskSummary) => {
    history.pushState({}, "", `/tasks/${task.humanId}`);
    setSelectedTask(task.humanId);
  };
  const closeTask = () => { history.pushState({}, "", "/"); setSelectedTask(null); };

  const reorder = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = tasks.findIndex((item) => item.id === active.id);
    const to = tasks.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    const next = [...tasks];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setTasks(next);
    try {
      await api.reorder(moved.id, next[to - 1]?.id ?? null, next[to + 1]?.id ?? null);
      await loadTasks();
    } catch (error) { handleAuthError(error); await loadTasks(); }
  };

  if (auth.loading) return <div className="splash"><div className="coffee-mark">✓</div><h1>Qahwa Tasks</h1></div>;
  if (!auth.configured) return <SetupRequired onSuccess={() => setAuth({ loading: false, authenticated: true, configured: true })} onError={fail} />;
  if (!auth.authenticated) return <Login onSuccess={() => setAuth({ loading: false, authenticated: true, configured: true })} onError={fail} />;

  const activeProjects = projects.filter((project) => !project.archivedAt);
  const openGroups = tab === "open" ? [
    { label: "In progress", items: tasks.filter((task) => task.status === "in_progress") },
    { label: "In review", items: tasks.filter((task) => task.status === "in_review") },
  ] : null;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span>✓</span><div><strong>Qahwa Tasks</strong><small>{counts.open} open</small></div></div>
      <button type="button" className="icon-button" onClick={() => setShowProjects(true)} aria-label="Manage projects"><Settings2 /></button>
      <select aria-label="Filter by project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">All projects</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </header>
    {offline && <div className="offline-banner"><WifiOff />Offline · showing the last loaded screen</div>}
    <main className="task-list">
      {openGroups ? openGroups.map((group) => <section className="task-group" key={group.label}><h2>{group.label}<span>{group.items.length}</span></h2>{group.items.map((task) => <TaskCard key={task.id} task={task} draggable={false} onOpen={() => openTask(task)} />)}{group.items.length === 0 && <EmptyState compact />}</section>) : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorder(event)}><SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>{tasks.map((task) => <TaskCard key={task.id} task={task} draggable={tab === "backlog" || tab === "todo"} onOpen={() => openTask(task)} />)}</SortableContext></DndContext>}
      {tasks.length === 0 && !openGroups && <EmptyState />}
    </main>
    {(tab === "backlog" || tab === "todo") && activeProjects.length > 0 && <button type="button" className="fab" onClick={() => setShowCreate(true)}><Plus /><span>Add task</span></button>}
    <nav className="bottom-tabs">{TABS.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon /><span>{label}</span>{counts[id] > 0 && <b>{counts[id]}</b>}</button>)}</nav>

    <Suspense fallback={<div className="screen-loading">Loading…</div>}>
    {showCreate && <CreateTask projects={activeProjects} initialProjectId={projectId || undefined} status={tab as "backlog" | "todo"} onCancel={() => setShowCreate(false)} onSave={async (value) => {
      try {
        const result = await api.createTask(value);
        setShowCreate(false);
        if (projectId && projectId !== value.projectId) setProjectId(value.projectId);
        const visible = await api.tasks(tab, projectId ? value.projectId : undefined);
        setTasks(visible.tasks);
        window.setTimeout(() => document.querySelector(`[data-task-id="${result.task.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
        window.setTimeout(() => document.querySelector(`[data-task-id="${result.task.id}"]`)?.classList.add("just-created"), 400);
      } catch (error) { handleAuthError(error); }
    }} />}
    {showProjects && <ProjectManager onClose={() => setShowProjects(false)} onChanged={() => void refresh()} onError={fail} />}
    {selectedTask && <TaskDetail taskId={selectedTask} onClose={closeTask} onChanged={() => void loadTasks()} onError={fail} />}
    </Suspense>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function Login({ onSuccess, onError }: { onSuccess: () => void; onError: (message: string) => void }) {
  const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  return <main className="login-page"><form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true);
    try { await api.login(password); onSuccess(); } catch (error) { onError(error instanceof Error ? error.message : "Login failed"); }
    finally { setBusy(false); }
  }}><div className="coffee-mark">✓</div><h1>Qahwa Tasks</h1><p>Your private workspace</p><label>Password<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary" disabled={busy || !password} type="submit">{busy ? "Signing in…" : "Sign in"}</button></form></main>;
}

function SetupRequired({ onSuccess, onError }: { onSuccess: () => void; onError: (message: string) => void }) {
  const token = new URLSearchParams(window.location.search).get("setup");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  if (!token) return <main className="login-page"><div className="setup-card"><div className="coffee-mark">✓</div><h1>Setup required</h1><p>Open the secure setup link delivered through Qahwa Notify.</p></div></main>;
  return <main className="login-page"><form onSubmit={async (event) => {
    event.preventDefault();
    if (password !== confirmation) { onError("Passwords do not match"); return; }
    setBusy(true);
    try { await api.setup(password, token); history.replaceState({}, "", "/"); onSuccess(); }
    catch (error) { onError(error instanceof Error ? error.message : "Setup failed"); }
    finally { setBusy(false); }
  }}><div className="coffee-mark">✓</div><h1>Choose your password</h1><p>This setup link expires after 15 minutes and works once.</p><label>Password<input autoFocus type="password" minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>Confirm password<input type="password" minLength={12} maxLength={256} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button className="primary" disabled={busy || password.length < 12 || password !== confirmation} type="submit">{busy ? "Securing app…" : "Save password"}</button></form></main>;
}

function EmptyState({ compact = false }: { compact?: boolean }) {
  return <div className={`empty-state${compact ? " compact" : ""}`}><span>✓</span><p>Nothing here yet.</p></div>;
}

function taskFromPath(): string | null {
  const match = window.location.pathname.match(/^\/tasks\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}
