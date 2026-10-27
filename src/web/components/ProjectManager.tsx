import { Archive, ArchiveRestore, Download, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "../../domain/types";
import { api } from "../api";
import { projectColorStyle } from "../project-color";
import { projectLogoValidationError } from "../project-logo";
import { ProjectLogo } from "./ProjectLogo";

export function ProjectManager({ onClose, onChanged, onError }: { onClose: () => void; onChanged: () => void; onError: (message: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [devices, setDevices] = useState<Array<{ id: string; name: string; lastSeenAt: string; revokedAt: string | null }>>([]);
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const load = async () => {
    const [projectResult, deviceResult] = await Promise.all([api.projects(true), api.devices()]);
    setProjects(projectResult.projects); setDevices(deviceResult.devices);
  };
  useEffect(() => { void load(); }, []);
  const act = async (operation: () => Promise<unknown>) => {
    try { await operation(); await load(); onChanged(); setEditing(null); }
    catch (error) { onError(error instanceof Error ? error.message : "Project action failed"); }
  };
  return <div className="sheet-page">
    <header className="sheet-header"><div><h1>Projects</h1><p>Names, task IDs and working directories</p></div><button className="icon-button" type="button" onClick={onClose}><X /></button></header>
    <main className="project-list">
      <button className="add-project-card" type="button" onClick={() => setEditing("new")}><Plus />Add project</button>
      {projects.map((project) => <article key={project.id} className={`project-card project-accent${project.archivedAt ? " archived" : ""}`} style={projectColorStyle(project.id)}>
        <ProjectLogo logo={project.logo} prefix={project.prefix} size="large" />
        <div><strong>{project.name} <span className="project-prefix-inline">{project.prefix}</span></strong><code>{project.rootDirectory}</code><small>{project.taskCount} task{project.taskCount === 1 ? "" : "s"}{project.archivedAt ? " · Archived" : ""}</small></div>
        <div className="project-actions">
          <button type="button" onClick={() => setEditing(project)} aria-label="Edit"><Pencil /></button>
          <button type="button" onClick={() => void act(() => api.archiveProject(project.id, !project.archivedAt))} aria-label={project.archivedAt ? "Restore" : "Archive"}>{project.archivedAt ? <ArchiveRestore /> : <Archive />}</button>
          {project.taskCount === 0 && <button type="button" className="danger" onClick={() => {
            if (window.confirm(`Permanently delete ${project.name}?`)) void act(() => api.deleteProject(project.id));
          }} aria-label="Delete"><Trash2 /></button>}
        </div>
      </article>)}
      <section className="settings-card">
        <div><strong>Paired devices</strong><small>Create a new one-time link on the Qahwa Tasks computer. Exports stay encrypted.</small></div>
        <button type="button" className="secondary" onClick={() => void encryptedExport(onError)}><Download />Encrypted export</button>
        {devices.some((device) => !device.revokedAt) && <div className="paired-devices"><strong>Paired devices</strong>{devices.filter((device) => !device.revokedAt).map((device) => <span key={device.id}><span>{device.name}<small>Seen {new Date(device.lastSeenAt).toLocaleString()}</small></span><button type="button" className="danger-subtle" onClick={() => {
          if (window.confirm(`Revoke ${device.name}?`)) void act(() => api.revokeDevice(device.id));
        }}>Revoke</button></span>)}</div>}
      </section>
    </main>
    {editing && <ProjectForm project={editing === "new" ? undefined : editing} onCancel={() => setEditing(null)} onSave={(value, logo, removeLogo) => act(async () => {
      const saved = editing === "new" ? await api.createProject(value) : await api.updateProject(editing.id, value);
      if (logo) await api.uploadProjectLogo(saved.project.id, logo);
      else if (removeLogo && saved.project.logo) await api.removeProjectLogo(saved.project.id);
    })} />}
  </div>;
}

async function encryptedExport(onError: (message: string) => void): Promise<void> {
  const passphrase = window.prompt("Export passphrase (12 characters or more)");
  if (!passphrase) return;
  if (passphrase.length < 12) { onError("Export passphrase must be at least 12 characters"); return; }
  try {
    const data = await api.exportData();
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 250_000, hash: "SHA-256" }, material,
      { name: "AES-GCM", length: 256 }, false, ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(data)));
    const payload = JSON.stringify({
      format: "qahwa-tasks-encrypted-v1", kdf: "PBKDF2-SHA256", iterations: 250_000,
      salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)),
    });
    const url = URL.createObjectURL(new Blob([payload], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `qahwa-tasks-${new Date().toISOString().slice(0, 10)}.enc`; anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) { onError(error instanceof Error ? error.message : "Export failed"); }
}

function base64(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function ProjectForm({ project, onCancel, onSave }: {
  project?: Project;
  onCancel: () => void;
  onSave: (value: { name: string; prefix?: string; rootDirectory: string }, logo: File | null, removeLogo: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [prefix, setPrefix] = useState(project?.prefix ?? "");
  const [rootDirectory, setRootDirectory] = useState(project?.rootDirectory ?? "/home/burawi/");
  const [logo, setLogo] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [saving, setSaving] = useState(false);
  const suggested = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return <div className="modal-backdrop"><form className="form-modal" onSubmit={(event) => {
    event.preventDefault();
    setSaving(true);
    void onSave({ name, prefix: prefix || suggested, rootDirectory }, logo, removeLogo).finally(() => setSaving(false));
  }}>
    <div className="form-heading"><div><h2>{project ? "Edit project" : "New project"}</h2><p>The prefix becomes permanent after the first task.</p></div><button type="button" className="icon-button" onClick={onCancel}><X /></button></div>
    <label>Name<input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Wassala" /></label>
    <label>Task prefix<input required minLength={2} maxLength={6} disabled={Boolean(project?.taskCount)} value={prefix || suggested} onChange={(event) => setPrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="WAS" /></label>
    <label>Root directory<input required value={rootDirectory} onChange={(event) => setRootDirectory(event.target.value)} placeholder="/home/burawi/wassala" /></label>
    <div className="logo-field">
      <div className="logo-preview"><ProjectLogo logo={removeLogo ? null : project?.logo ?? null} prefix={prefix || suggested || "PRJ"} size="large" /><div><strong>Project logo</strong><small>PNG, JPEG, or WebP · up to 256 KB</small>{logo && <small>{logo.name}</small>}</div></div>
      <label className="secondary file-button">Choose image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
        const file = event.target.files?.[0] ?? null;
        setLogoError("");
        if (!file) { setLogo(null); return; }
        const validationError = projectLogoValidationError(file);
        if (validationError) { setLogo(null); setLogoError(validationError); return; }
        setLogo(file); setRemoveLogo(false);
      }} /></label>
      {project?.logo && !removeLogo && !logo && <button type="button" className="danger-subtle" onClick={() => setRemoveLogo(true)}>Remove logo</button>}
      {removeLogo && <button type="button" className="secondary" onClick={() => setRemoveLogo(false)}>Keep current logo</button>}
      {logoError && <small className="form-hint error">{logoError}</small>}
    </div>
    <div className="button-row"><button type="button" className="secondary" disabled={saving} onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={saving || Boolean(logoError)}>{saving ? "Saving…" : "Save project"}</button></div>
  </form></div>;
}
