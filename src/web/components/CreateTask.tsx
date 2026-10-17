import { X } from "lucide-react";
import { useState } from "react";
import { emptyDocument, type Project, type RichTextDocument } from "../../domain/types";
import { RichEditor } from "./RichEditor";

export function CreateTask({ projects, initialProjectId, status, onCancel, onProjectChange, onSave }: {
  projects: Project[];
  initialProjectId?: string;
  status: "backlog" | "todo";
  onCancel: () => void;
  onProjectChange: (projectId: string) => void;
  onSave: (value: { projectId: string; title: string; description: RichTextDocument; status: "backlog" | "todo" }) => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState<RichTextDocument>(emptyDocument());
  return <div className="modal-backdrop"><form className="form-modal task-form" onSubmit={(event) => {
    event.preventDefault();
    onSave({ projectId, title, description, status });
  }}>
    <div className="form-heading"><div><h2>New {status === "todo" ? "Todo" : "backlog task"}</h2><p>It will be placed at the bottom.</p></div><button type="button" className="icon-button" onClick={onCancel}><X /></button></div>
    <label>Project<select required value={projectId} onChange={(event) => {
      setProjectId(event.target.value);
      onProjectChange(event.target.value);
    }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <label>Title<input autoFocus required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to be done?" /></label>
    <label>Description<RichEditor value={description} onChange={setDescription} placeholder="Add context, details or a checklist…" /></label>
    <div className="button-row"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={!title.trim() || !projectId}>Create task</button></div>
  </form></div>;
}
