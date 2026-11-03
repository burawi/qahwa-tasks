import { useEffect, useState } from "react";
import { DEFAULT_ORCHESTRATOR_SETTINGS, MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH, MAX_ORCHESTRATOR_NAME_LENGTH, orchestratorSettingsError, type OrchestratorSettings } from "../../domain/orchestrator-settings";
import { api } from "../api";
import { OrchestratorAvatarSettings } from "./OrchestratorAvatarSettings";

export function OrchestratorSettingsForm({ settings, loadError, connected, onSaved }: {
  settings: OrchestratorSettings | null;
  loadError: string;
  connected: boolean;
  onSaved: (settings: OrchestratorSettings) => void;
}) {
  const [draft, setDraft] = useState<OrchestratorSettings>({ ...DEFAULT_ORCHESTRATOR_SETTINGS });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (settings && !dirty) setDraft(settings);
  }, [settings, dirty]);
  const validationError = orchestratorSettingsError(draft);
  const save = async (value: OrchestratorSettings, reset = false) => {
    setSaving(true); setError(""); setStatus("");
    try {
      const result = await api.saveOrchestratorSettings(value);
      onSaved(result.settings);
      setDraft(result.settings); setDirty(false);
      setStatus(reset ? "Defaults restored." : "Settings saved.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save settings"); }
    finally { setSaving(false); }
  };
  return <form className="settings-card orchestrator-settings" aria-label="Orchestrator settings" onSubmit={(event) => {
    event.preventDefault();
    if (settings && connected && !saving && !validationError) void save(draft);
  }}>
    <div><strong>{settings?.name ?? DEFAULT_ORCHESTRATOR_SETTINGS.name}</strong><small>Give your portfolio companion a name and some guidance.</small></div>
    <OrchestratorAvatarSettings connected={connected} />
    {!settings && <p role="status">{loadError || (connected ? "Loading settings…" : "Connect to load settings.")}</p>}
    <fieldset disabled={!settings || !connected || saving}>
      <label>Name<input required maxLength={MAX_ORCHESTRATOR_NAME_LENGTH} value={draft.name} onChange={(event) => {
        setDraft((current) => ({ ...current, name: event.target.value })); setDirty(true); setStatus(""); setError("");
      }} autoComplete="off" /></label>
      <label>Custom instructions<textarea rows={5} maxLength={MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH} value={draft.customInstructions} onChange={(event) => {
        setDraft((current) => ({ ...current, customInstructions: event.target.value })); setDirty(true); setStatus(""); setError("");
      }} placeholder="For example: Keep updates concise and use a friendly tone." aria-describedby="orchestrator-instructions-help" /></label>
      <small id="orchestrator-instructions-help">Applies to future turns, including automatic updates. Task actions still need authorization in chat or an applicable standing directive. Saved on the server, shared across paired devices, and kept when chat is cleared.</small>
      <div className="button-row">
        <button type="button" className="secondary" onClick={() => void save({ ...DEFAULT_ORCHESTRATOR_SETTINGS }, true)}>Reset to defaults</button>
        <button type="submit" className="primary" disabled={!dirty || Boolean(validationError)}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </fieldset>
    {(error || (dirty && validationError)) && <p className="form-hint error" role="alert">{error || validationError}</p>}
    {settings && loadError && <p role="status">{loadError}</p>}
    {!connected && settings && <p role="status">Reconnect to save changes.</p>}
    {status && <p role="status">{status}</p>}
  </form>;
}
