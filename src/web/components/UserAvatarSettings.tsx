import { useEffect, useState } from "react";
import { USER_AVATAR_SIZE_LABEL, userAvatarValidationError } from "../../domain/user-avatar";
import { useUserAvatar } from "../user-avatar";
import { UserAvatar } from "./UserAvatar";

export function UserAvatarSettings({ connected }: { connected: boolean }) {
  const avatar = useUserAvatar();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const save = async (reset = false) => {
    setBusy(true); setError(""); setStatus("");
    try {
      if (reset) await avatar.reset();
      else if (file) await avatar.save(file);
      setFile(null);
      setStatus(reset ? "Default avatar restored." : "Avatar saved.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save your avatar"); }
    finally { setBusy(false); }
  };

  return <section className="settings-card avatar-settings" aria-label="Your avatar">
    <div><strong>Your avatar</strong><small>A little personality for your messages. Synced across your paired devices.</small></div>
    <fieldset disabled={!connected || !avatar.loaded || busy}>
      <div className="avatar-preview"><UserAvatar preview={preview} large decorative={false} /><div><strong>{file ? "Preview" : "You"}</strong><small>PNG, JPEG, or WebP · up to {USER_AVATAR_SIZE_LABEL}</small>{file && <small className="avatar-filename">{file.name}</small>}</div></div>
      <div className="button-row">
        <label className="secondary file-button">{avatar.avatar || file ? "Replace image" : "Choose image"}<input type="file" aria-label="Choose avatar image" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.currentTarget.value = "";
          if (!chosen) return;
          setStatus("");
          const invalid = userAvatarValidationError(chosen);
          setError(invalid ?? "");
          if (!invalid) setFile(chosen);
        }} /></label>
        {file && <><button type="button" className="primary" onClick={() => void save()}>{busy ? "Saving…" : "Save avatar"}</button><button type="button" className="secondary" onClick={() => { setFile(null); setError(""); setStatus(""); }}>Cancel</button></>}
        {avatar.avatar && <button type="button" className="danger-subtle" onClick={() => void save(true)}>Reset to default</button>}
      </div>
    </fieldset>
    {!connected && <p role="status">Connect to change your avatar.</p>}
    {connected && !avatar.loaded && !avatar.error && <p role="status">Loading your avatar…</p>}
    {(error || avatar.error) && <p className="form-hint error" role="alert">{error || avatar.error}</p>}
    {status && <p role="status">{status}</p>}
  </section>;
}
