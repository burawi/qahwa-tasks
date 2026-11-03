import { useState } from "react";
import { useTheme, type ThemePreference } from "../theme";

export function ThemeSettings() {
  const { preference, setPreference } = useTheme();
  const [saved, setSaved] = useState(true);
  return <section className="settings-card theme-settings" aria-labelledby="theme-settings-title">
    <div><strong id="theme-settings-title">Appearance</strong><small id="theme-settings-help">Choose a theme for this device. System follows your device’s appearance.</small></div>
    <label htmlFor="theme-preference">Theme</label>
    <select id="theme-preference" value={preference} aria-describedby="theme-settings-help" onChange={event => setSaved(setPreference(event.target.value as ThemePreference))}>
      <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
    </select>
    {!saved && <small role="status">Theme applied. Browser storage is unavailable, so it may reset when you reload.</small>}
  </section>;
}
