// Real creation sheet with in-memory API responses. Never touches production.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CreateTask } from 'creation-source';
import { api, ApiError } from 'creation-api';
import 'creation-styles';

const fixture = window.creationKeyboardFixture = { saves: [], uploads: [], cancelled: [] };
const projects = [{ id: 'keyboard-project', name: 'Qahwa Tasks', prefix: 'QAH', logo: null }];
api.uploadAttachment = async (ownerType, ownerId, file, progress) => {
  fixture.uploads.push({ ownerType, ownerId, name: file.name });
  progress(100);
  return { id: crypto.randomUUID(), name: file.name, mimeType: file.type, size: file.size };
};
api.cancelTaskDraft = async id => { fixture.cancelled.push(id); };
api.removeAttachment = async () => {};
function Fixture() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>New task</button>
    {open && <CreateTask projects={projects} initialProjectId={projects[0].id}
      onCancel={() => setOpen(false)} onProjectChange={() => {}} onTerminal={async () => {}}
      onSave={async value => { fixture.saves.push(value); throw new ApiError('Retained draft after validation failure', 'fixture_failure', 400); }} />}
  </>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
