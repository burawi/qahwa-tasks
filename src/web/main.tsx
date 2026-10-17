import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

declare global {
  interface Window {
    __QAHWA_BOOT__?: { ready: () => void; report: (category: string, value: unknown) => void };
  }
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    window.__QAHWA_BOOT__?.report("react-error", `${error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="login-page"><div className="setup-card" role="alert"><div className="coffee-mark">!</div><h1>Qahwa Tasks could not render</h1><p>A safe diagnostic was recorded. Reload the app to retry.</p><button className="primary" type="button" onClick={() => location.reload()}>Reload</button></div></main>;
  }
}

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.__QAHWA_BOOT__?.ready()));

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
