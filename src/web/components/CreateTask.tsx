import { X } from "lucide-react";
import { useState } from "react";
import { documentFromPlainText, type Project, type RichTextDocument } from "../../domain/types";

export function CreateTask({ projects, initialProjectId, onCancel, onProjectChange, onSave }: {
  projects: Project[];
  initialProjectId?: string;
  onCancel: () => void;
  onProjectChange: (projectId: string) => void;
  onSave: (value: { projectId: string; title: string; description: RichTextDocument; status: "backlog" | "todo" }) => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [note, setNote] = useState("");
  return <div className="modal-backdrop"><form className="form-modal task-form" onSubmit={(event) => {
    event.preventDefault();
    const clean = note.trim();
    const firstLine = clean.split("\n").find(Boolean) ?? clean;
    const title = firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
    onSave({ projectId, title, description: documentFromPlainText(clean), status: "backlog" });
  }}>
    <div className="form-heading"><div><h2>New task</h2><p>Capture the thought now. It will not start until you or the orchestrator triggers it.</p></div><button type="button" className="icon-button" onClick={onCancel}><X /></button></div>
    <label>Project<select required value={projectId} onChange={(event) => {
      setProjectId(event.target.value);
      onProjectChange(event.target.value);
    }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <label>What needs doing?<textarea autoFocus required maxLength={30_000} rows={7} value={note} onChange={(event) => setNote(event.target.value)} placeholder="A quick note is enough. The task session can clarify it later." /></label>
    <div className="button-row"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={!note.trim() || !projectId}>Create task</button></div>
  </form></div>;
}
