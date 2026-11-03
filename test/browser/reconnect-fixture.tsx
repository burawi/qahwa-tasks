// Local-only transport fixture: real App, client encryption, and components.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import nacl from "tweetnacl";
import "reconnect-styles";

const stamp = "2026-10-28T10:00:00.000Z";
const clientKeys = nacl.box.keyPair();
const serverKeys = nacl.box.keyPair();
const b64 = (value) => btoa(String.fromCharCode(...value));
const bytes = (value) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const profileKey = "qahwa-tasks-pairing-v2";
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "orchestrator" ? "orchestrator" : "task";
const project = { id: "project", name: "Qahwa", prefix: "QAH", rootDirectory: "/fixture", archivedAt: null, logo: null };
const task = { id: "fixture", humanId: "QAH-0014", title: "Reconnect fixture", projectId: project.id, projectName: project.name, projectPrefix: project.prefix, status: "in_progress", tone: "blue", surface: "chat", sessionState: "idle", smartMessage: "Ready", lastActivityAt: stamp, createdAt: stamp };
const workspace = { session: { id: "fixture", runState: "idle", surface: "chat", intakeState: "ready" }, messages: Array.from({ length: 30 }, (_, i) => ({ id: `message-${i}`, role: "assistant", body: `Retained chat message ${i}`, createdAt: stamp })), pendingRequests: [{ id: "question", requestType: "user_input", payload: { questions: [{ id: "scope", question: "Fixture scope" }] } }], design: null, designPages: [], selectedDesignPageId: null, recentEvents: [], workActivities: [] };
const profile = { endpoint: "wss://fixture.invalid/rpc", deviceId: "fixture", deviceName: "Fixture", clientPublicKey: b64(clientKeys.publicKey), clientSecretKey: b64(clientKeys.secretKey), serverPublicKey: b64(serverKeys.publicKey) };
localStorage.removeItem(profileKey);
if (params.get("initial") !== "unpaired") localStorage.setItem(profileKey, JSON.stringify(profile));
const shared = nacl.box.before(clientKeys.publicKey, serverKeys.secretKey);
let current;
const controls = window.reconnectFixture = {
  unavailable: params.get("initial") === "unavailable", hold: false, revoked: false, mutations: [], requests: [],
  drop() { this.unavailable = true; current?.close(); },
  resume() { this.unavailable = false; },
  ready() { this.hold = false; current?.receive({ type: "ready" }); },
  expire() { this.expired = true; },
};
class FixtureSocket {
  static OPEN = 1;
  readyState = 0;
  onopen = null; onclose = null; onerror = null; onmessage = null;
  constructor() {
    current = this;
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      if (controls.unavailable) this.onerror?.();
      else { this.readyState = 1; this.onopen?.(); }
    });
  }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(value) {
    const frame = JSON.parse(value);
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      if (frame.type === "hello") this.receive(controls.revoked ? { type: "error", message: "Unknown or revoked device" } : { type: "challenge", challenge: "fixture-challenge" });
      else if (frame.type === "auth") {
        const proof = nacl.box.open(bytes(frame.proof), bytes(frame.nonce), clientKeys.publicKey, serverKeys.secretKey);
        if (!proof || new TextDecoder().decode(proof) !== "fixture-challenge") throw new Error("Fixture authentication failed");
        if (!controls.hold) this.receive({ type: "ready" });
      } else if (frame.type === "box") {
        const opened = nacl.secretbox.open(bytes(frame.payload), bytes(frame.nonce), shared);
        if (!opened) throw new Error("Fixture decryption failed");
        const rpc = JSON.parse(new TextDecoder().decode(opened));
        const { path, method } = rpc.params;
        controls.requests.push(path);
        if (method !== "GET") controls.mutations.push(rpc.params);
        let body;
        let status = 200;
        if (controls.expired) { controls.expired = false; status = 401; body = { error: "session_expired", message: "Session expired" }; }
        else if (path === "/api/settings/avatar") body = { avatar: null };
        else if (path === "/api/settings/orchestrator") body = { settings: { name: "Orchestrator", customInstructions: "" } };
        else if (path.endsWith("/unread") || path.endsWith("/read")) body = { readState: { unreadCount: 0, unreadMessageIds: [] } };
        else if (path.startsWith("/api/projects")) body = { projects: [project] };
        else if (path.startsWith("/api/tasks?") || path === "/api/tasks") body = { tasks: [task] };
        else if (path === "/api/tasks/QAH-0014" || path === "/api/tasks/fixture") body = { task };
        else if (path.includes("/messages")) {
          workspace.messages.push({ id: `sent-${workspace.messages.length}`, role: "user", body: rpc.params.body.message, createdAt: stamp }); body = { workspace };
        } else if (path.endsWith("/attachments") && method === "POST") { status = 201; body = { attachment: { id: "upload", filename: rpc.params.body.filename, size: rpc.params.body.size, mediaType: rpc.params.body.mediaType, status: "available", chunkBytes: 256 * 1024 } }; }
        else if (path.endsWith("/complete")) body = { attachment: { id: "upload", filename: "draft.txt", size: 5, mediaType: "text/plain", status: "available" } };
        else if (path.startsWith("/api/attachments")) body = {};
        else if (path.startsWith("/api/orchestrator") || path.includes("/workspace")) body = { workspace, revision: "fixture", messagesRevision: "fixture", capacity: { activeTurns: 0, recommendedParallelism: 2, availableSlots: 2 } };
        else if (path.includes("/diagnostics")) body = {};
        else throw new Error(`Unhandled fixture route ${method} ${path}`);
        const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
        this.receive({ type: "box", nonce: b64(nonce), payload: b64(nacl.secretbox(new TextEncoder().encode(JSON.stringify({ id: rpc.id, result: { status, body } })), nonce, shared)) });
      }
    });
  }
}
window.WebSocket = FixtureSocket;
history.replaceState({}, "", `${mode === "task" ? "/tasks/QAH-0014" : "/orchestrator"}${location.search}`);
const { connection } = await import("reconnect-api");
controls.connect = () => connection.connect().catch(() => undefined);
controls.disconnect = () => connection.disconnect();
controls.state = () => connection.state();
const { App } = await import("reconnect-app");
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
