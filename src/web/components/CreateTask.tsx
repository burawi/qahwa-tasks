import { ArrowRight, Lightbulb, X } from "lucide-react";
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
    <div className="form-heading"><div><span className="modal-kicker">Quick capture</span><h2>What should happen?</h2><p>A rough note is enough. The task will clarify itself with you before it does any work.</p></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Close"><X /></button></div>
    <label>Project<select required value={projectId} onChange={(event) => {
      setProjectId(event.target.value);
      onProjectChange(event.target.value);
    }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <label>Task note<textarea autoFocus required maxLength={30_000} rows={7} value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. The order screen feels confusing on mobile. Review it and propose a simpler flow." /></label>
    <div className="capture-note"><Lightbulb /><span>Creating this task will not start it.</span></div>
    <div className="button-row"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={!note.trim() || !projectId}>Create task <ArrowRight /></button></div>
  </form></div>;
}
