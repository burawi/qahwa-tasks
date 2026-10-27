import type { Project, RichTextDocument, TaskComment, TaskDetail, TaskStatus, TaskSummary, TaskWorkspace } from "../domain/types";
import nacl from "tweetnacl";

const PROFILE_KEY = "qahwa-tasks-pairing-v2";
export type ConnectionState = "unpaired" | "connecting" | "online" | "offline";
interface PairingProfile {
  endpoint: string;
  deviceId: string;
  deviceName: string;
  clientPublicKey: string;
  clientSecretKey: string;
  serverPublicKey: string;
}

export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
  }
}

const bytesToB64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const b64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

function pairingData(uri: string): { endpoint: string; grant: string; serverPublicKey: string } {
  const parsed = new URL(uri.trim().replace(/^qahwa:\/\//, "https://qahwa.invalid/").replace(/^kahwa:\/\//, "https://qahwa.invalid/"));
  const endpoint = parsed.searchParams.get("endpoint") ?? "";
  const grant = parsed.searchParams.get("grant") ?? "";
  const serverPublicKey = parsed.searchParams.get("serverKey") ?? "";
  if (!endpoint || !grant || !serverPublicKey) throw new Error("The pairing link is incomplete");
  if (!/^wss?:\/\//.test(endpoint)) throw new Error("The server endpoint must use WebSocket");
  return { endpoint, grant, serverPublicKey };
}

type RpcResult = { status: number; contentType: string; body?: unknown; bodyBase64?: string };
type Pending = { resolve: (value: RpcResult) => void; reject: (error: Error) => void; timer: number };

class QahwaClient {
  private socket: WebSocket | null = null;
  private sharedKey: Uint8Array | null = null;
  private state: ConnectionState = "unpaired";
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly pending = new Map<string, Pending>();
  private reconnectTimer?: number;
  private closed = false;
  profile: PairingProfile | null = null;

  currentState(): ConnectionState { return this.state; }
  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  private setState(state: ConnectionState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  readProfile(): PairingProfile | null {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "null") as PairingProfile | null; }
    catch { return null; }
  }
  async pair(uri: string): Promise<void> {
    const data = pairingData(uri);
    const keyPair = nacl.box.keyPair();
    const profile: PairingProfile = {
      endpoint: data.endpoint,
      deviceId: crypto.randomUUID(),
      deviceName: navigator.userAgent.includes("Mobile") ? "Mobile browser" : "Web browser",
      clientPublicKey: bytesToB64(keyPair.publicKey),
      clientSecretKey: bytesToB64(keyPair.secretKey),
      serverPublicKey: data.serverPublicKey,
    };
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(data.endpoint);
      const timer = window.setTimeout(() => { socket.close(); reject(new Error("The Qahwa server did not answer")); }, 10_000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "pair", grant: data.grant, deviceId: profile.deviceId, deviceName: profile.deviceName, publicKey: profile.clientPublicKey }));
      socket.onerror = () => { window.clearTimeout(timer); socket.close(); reject(new Error("Could not reach that Qahwa server")); };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "error") { window.clearTimeout(timer); socket.close(); reject(new Error(String(message.message ?? "Pairing failed"))); }
        if (message.type === "paired") {
          window.clearTimeout(timer);
          if (message.serverPublicKey !== profile.serverPublicKey) { socket.close(); reject(new Error("Server identity did not match the pairing link")); return; }
          localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
          socket.close();
          resolve();
        }
      };
    });
    await this.connect();
  }
  async connect(): Promise<void> {
    const profile = this.readProfile();
    this.profile = profile;
    if (!profile) { this.setState("unpaired"); return; }
    this.closed = false;
    this.setState("connecting");
    const previous = this.socket;
    this.socket = null;
    if (previous) { previous.onclose = null; previous.close(); }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(profile.endpoint);
      this.socket = socket;
      const timer = window.setTimeout(() => { socket.close(); reject(new Error("Connection timed out")); }, 10_000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", deviceId: profile.deviceId }));
      socket.onerror = () => { window.clearTimeout(timer); reject(new Error("Your Qahwa server is unavailable")); };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "challenge") {
          const serverKey = b64ToBytes(profile.serverPublicKey);
          const clientSecret = b64ToBytes(profile.clientSecretKey);
          const nonce = nacl.randomBytes(nacl.box.nonceLength);
          this.sharedKey = nacl.box.before(serverKey, clientSecret);
          const proof = nacl.box(new TextEncoder().encode(String(message.challenge)), nonce, serverKey, clientSecret);
          socket.send(JSON.stringify({ type: "auth", nonce: bytesToB64(nonce), proof: bytesToB64(proof), protocolVersion: 1 }));
        } else if (message.type === "ready") {
          window.clearTimeout(timer);
          this.setState("online");
          resolve();
        } else if (message.type === "box") this.handleBox(message);
        else if (message.type === "error") {
          window.clearTimeout(timer);
          reject(new Error(String(message.message ?? "Authentication failed")));
        }
      };
      socket.onclose = () => {
        this.socket = null;
        this.sharedKey = null;
        if (this.state === "online" || this.state === "connecting") this.setState(profile ? "offline" : "unpaired");
        for (const pending of this.pending.values()) pending.reject(new Error("Connection closed"));
        this.pending.clear();
        if (!this.closed) this.scheduleReconnect();
      };
    }).catch((error) => {
      this.setState("offline");
      if (!this.closed) this.scheduleReconnect();
      throw error;
    });
  }
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    localStorage.removeItem(PROFILE_KEY);
    this.profile = null;
    this.setState("unpaired");
  }
  async request(params: Record<string, unknown>): Promise<RpcResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.sharedKey) throw new Error("Qahwa server is not connected");
    const id = crypto.randomUUID();
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const sealed = nacl.secretbox(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method: "api.request", params })), nonce, this.sharedKey);
    const promise = new Promise<RpcResult>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error("Request timed out")); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ type: "box", nonce: bytesToB64(nonce), payload: bytesToB64(sealed) }));
    return promise;
  }
  private handleBox(message: Record<string, unknown>) {
    if (!this.sharedKey) return;
    const opened = nacl.secretbox.open(b64ToBytes(String(message.payload ?? "")), b64ToBytes(String(message.nonce ?? "")), this.sharedKey);
    if (!opened) return;
    const envelope = JSON.parse(new TextDecoder().decode(opened)) as { id?: string; result?: RpcResult; error?: { message?: string } };
    if (!envelope.id) return;
    const pending = this.pending.get(envelope.id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pending.delete(envelope.id);
    if (envelope.error) pending.reject(new Error(envelope.error.message ?? "Request failed"));
    else pending.resolve(envelope.result!);
  }
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, 2500 + Math.random() * 1200);
  }
}

const client = new QahwaClient();
export const connection = {
  state: () => client.currentState(),
  profile: () => client.readProfile(),
  subscribe: (listener: (state: ConnectionState) => void) => client.subscribe(listener),
  connect: () => client.connect(),
  pair: (uri: string) => client.pair(uri),
  disconnect: () => client.disconnect(),
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let body: unknown;
  if (typeof options.body === "string") body = JSON.parse(options.body);
  const result = await client.request({ path, method: options.method ?? "GET", body });
  const responseBody = (result.body ?? {}) as { message?: string; error?: string };
  if (result.status < 200 || result.status >= 300) throw new ApiError(responseBody.message ?? "Request failed", responseBody.error ?? "request_failed", result.status);
  return result.status === 204 ? undefined as T : result.body as T;
}

async function uploadProjectLogo(id: string, file: File): Promise<{ project: Project }> {
  const bodyBase64 = bytesToB64(new Uint8Array(await file.arrayBuffer()));
  const result = await client.request({
    path: `/api/projects/${encodeURIComponent(id)}/logo`, method: "PUT", bodyBase64,
    headers: { "content-type": file.type || "application/octet-stream" },
  });
  const body = (result.body ?? {}) as { project?: Project; message?: string; error?: string };
  if (result.status < 200 || result.status >= 300) throw new ApiError(body.message ?? "Logo upload failed", body.error ?? "request_failed", result.status);
  return body as { project: Project };
}

export async function fetchEncryptedAsset(path: string): Promise<Blob> {
  const cached = assetCache.get(path);
  if (cached) return cached;
  const pending = fetchEncryptedAssetUncached(path);
  assetCache.set(path, pending);
  pending.catch(() => assetCache.delete(path));
  return pending;
}

const assetCache = new Map<string, Promise<Blob>>();

async function fetchEncryptedAssetUncached(path: string): Promise<Blob> {
  const result = await client.request({ path, method: "GET" });
  if (result.status < 200 || result.status >= 300 || !result.bodyBase64) throw new ApiError("Asset unavailable", "asset_unavailable", result.status);
  const decoded = b64ToBytes(result.bodyBase64);
  const data = new Uint8Array(decoded.length);
  data.set(decoded);
  return new Blob([data.buffer], { type: result.contentType || "application/octet-stream" });
}

export const api = {
  logout: async () => connection.disconnect(),
  projects: (includeArchived = false) => request<{ projects: Project[] }>(`/api/projects?includeArchived=${includeArchived}`),
  createProject: (body: { name: string; prefix?: string; rootDirectory: string }) =>
    request<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, body: { name?: string; prefix?: string; rootDirectory?: string }) =>
    request<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveProject: (id: string, archived: boolean) => request<{ project: Project }>(`/api/projects/${id}/archive`, {
    method: "POST", body: JSON.stringify({ archived }),
  }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  uploadProjectLogo,
  removeProjectLogo: (id: string) => request<{ project: Project }>(`/api/projects/${id}/logo`, { method: "DELETE" }),
  devices: () => request<{ devices: Array<{ id: string; name: string; createdAt: string; lastSeenAt: string; revokedAt: string | null }> }>("/api/devices"),
  revokeDevice: (id: string) => request<{ revoked: boolean }>(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  tasks: (tab: "all" | "active" | "backlog" | "todo" | "open" | "closed" = "all", projectId?: string) => request<{ tasks: TaskSummary[] }>(
    `/api/tasks?tab=${tab}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
  ),
  task: (id: string) => request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (body: { projectId: string; title: string; description: RichTextDocument; status: "backlog" | "todo" }) =>
    request<{ task: TaskDetail }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, body: { title: string; description: RichTextDocument; expectedVersion: number }) =>
    request<{ task: TaskDetail }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  transition: (id: string, to: TaskStatus, outcome?: "completed" | "cancelled") => request<{ task: TaskDetail }>(
    `/api/tasks/${id}/transition`, { method: "POST", body: JSON.stringify({ to, outcome }) },
  ),
  reorder: (id: string, beforeId?: string | null, afterId?: string | null) => request<{ task: TaskDetail }>(
    `/api/tasks/${id}/reorder`, { method: "POST", body: JSON.stringify({ beforeId, afterId }) },
  ),
  deleteTask: (id: string) => request<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  addRelatedTask: (id: string, relatedTaskId: string) => request<{ task: TaskDetail }>(`/api/tasks/${id}/related`, {
    method: "POST", body: JSON.stringify({ relatedTaskId }),
  }),
  removeRelatedTask: (id: string, relatedTaskId: string) => request<{ task: TaskDetail }>(
    `/api/tasks/${id}/related/${encodeURIComponent(relatedTaskId)}`, { method: "DELETE" },
  ),
  addComment: (id: string, body: RichTextDocument, parentId?: string) => request<{ comment: TaskComment }>(
    `/api/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ body, parentId }) },
  ),
  resolveComment: (id: string, resolved: boolean, reply?: RichTextDocument) => request<{ comment: TaskComment }>(
    `/api/comments/${id}/resolution`, { method: "POST", body: JSON.stringify({ resolved, reply }) },
  ),
  activity: (id: string) => request<{ activity: Array<{ actor: string; eventType: string; createdAt: string }> }>(
    `/api/tasks/${id}/activity`,
  ),
  approveCommit: (id: string, outputId: string) => request<{ task: TaskDetail }>(
    `/api/tasks/${encodeURIComponent(id)}/outputs/${encodeURIComponent(outputId)}/approve-commit`, { method: "POST" },
  ),
  workspace: (id: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/workspace`),
  triggerTask: (id: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/trigger`, { method: "POST" }),
  sendTaskMessage: (id: string, message: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/messages`, {
    method: "POST", body: JSON.stringify({ message }),
  }),
  interruptTask: (id: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/interrupt`, { method: "POST" }),
  orchestrator: () => request<{ workspace: TaskWorkspace; capacity: { activeTurns: number; recommendedParallelism: number; availableSlots: number } }>("/api/orchestrator"),
  sendOrchestratorMessage: (message: string) => request<{ workspace: TaskWorkspace }>("/api/orchestrator/messages", {
    method: "POST", body: JSON.stringify({ message }),
  }),
  interruptOrchestrator: () => request<{ workspace: TaskWorkspace }>("/api/orchestrator/interrupt", { method: "POST" }),
  cleanOrchestrator: () => request<{ workspace: TaskWorkspace }>("/api/orchestrator/clean", { method: "POST" }),
  respondToRequest: (requestId: string, body: { approved?: boolean; answers?: Record<string, string> }) => request<{ resolved: boolean }>(
    `/api/session-requests/${encodeURIComponent(requestId)}/respond`, { method: "POST", body: JSON.stringify(body) },
  ),
  exportData: () => request<Record<string, unknown>>("/api/export"),
};
