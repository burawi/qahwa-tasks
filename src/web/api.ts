import type { ChatModelOption, ChatModelSelection } from "../domain/chat-model";
import type { ChatAttachment, ChatReadState, Project, RichTextDocument, TaskDetail, TaskStatus, TaskSummary, TaskWorkspace, TerminalView, WorkspaceCursor, WorkspacePoll } from "../domain/types";
import nacl from "tweetnacl";
import type { OrchestratorSettings } from "../domain/orchestrator-settings";
import type { UserAvatar } from "../domain/user-avatar";
import type { CodexUsage } from "../domain/codex-usage";
import type { CanvasCommentAnchor } from "../domain/canvas-comment";

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

const bytesToB64 = (value: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
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

type RpcResult = { status: number; contentType: string; contentRange?: string; body?: unknown; bodyBase64?: string };
type Pending = { resolve: (value: RpcResult) => void; reject: (error: Error) => void; timer: number };

class QahwaClient {
  private socket: WebSocket | null = null;
  private sharedKey: Uint8Array | null = null;
  private state: ConnectionState = this.readProfile() ? "connecting" : "unpaired";
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly pending = new Map<string, Pending>();
  private reconnectTimer?: number;
  private closed = false;
  private cancelConnect?: () => void;
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
    try {
      const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "null") as PairingProfile | null;
      if (!profile || typeof profile.endpoint !== "string" || typeof profile.deviceId !== "string" || !profile.deviceId) return null;
      const endpoint = new URL(profile.endpoint);
      if (!["ws:", "wss:"].includes(endpoint.protocol)) return null;
      for (const key of [profile.serverPublicKey, profile.clientPublicKey, profile.clientSecretKey]) {
        if (typeof key !== "string" || b64ToBytes(key).length !== nacl.box.publicKeyLength) return null;
      }
      return profile;
    }
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
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending("Connection replaced while reconnecting");
    this.stopTransport();
    const profile = this.readProfile();
    this.profile = profile;
    if (!profile) { this.disconnect(); return; }
    this.closed = false;
    this.setState("connecting");
    let socket: WebSocket;
    try { socket = new WebSocket(profile.endpoint); }
    catch (error) {
      this.setState("offline");
      this.scheduleReconnect();
      throw error;
    }
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.cancelConnect = undefined;
        if (error) reject(error); else resolve();
      };
      const unavailable = (error: Error) => {
        if (this.socket !== socket) return;
        finish(error);
        this.stopTransport();
        this.rejectPending("Connection closed");
        this.setState("offline");
        if (!this.closed) this.scheduleReconnect();
      };
      const timer = window.setTimeout(() => unavailable(new Error("Connection timed out")), 10_000);
      this.cancelConnect = () => finish(new Error("Connection replaced while reconnecting"));
      socket.onopen = () => {
        if (this.socket === socket) socket.send(JSON.stringify({ type: "hello", deviceId: profile.deviceId }));
      };
      socket.onerror = () => unavailable(new Error("Your Qahwa server is unavailable"));
      socket.onclose = () => unavailable(new Error("Connection closed"));
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        try {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "challenge") {
            const serverKey = b64ToBytes(profile.serverPublicKey);
            const clientSecret = b64ToBytes(profile.clientSecretKey);
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            this.sharedKey = nacl.box.before(serverKey, clientSecret);
            const proof = nacl.box(new TextEncoder().encode(String(message.challenge)), nonce, serverKey, clientSecret);
            socket.send(JSON.stringify({ type: "auth", nonce: bytesToB64(nonce), proof: bytesToB64(proof), protocolVersion: 1 }));
          } else if (message.type === "ready" && this.sharedKey) {
            finish();
            this.setState("online");
          } else if (message.type === "box") this.handleBox(message);
          else if (message.type === "error") {
            const detail = String(message.message ?? "Connection failed");
            // These are the server's explicit credential rejection responses.
            // Transport errors and session expiry keep the paired device identity.
            if (detail === "Unknown or revoked device" || detail === "Authentication failed") {
              finish(new Error(detail));
              this.disconnect();
            } else unavailable(new Error(detail));
          }
        } catch (error) {
          unavailable(error instanceof Error ? error : new Error("Invalid server response"));
        }
      };
    });
  }
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopTransport();
    this.rejectPending("Disconnected");
    localStorage.removeItem(PROFILE_KEY);
    this.profile = null;
    this.setState("unpaired");
  }
  private stopTransport(): void {
    const previous = this.socket;
    this.socket = null;
    this.sharedKey = null;
    this.cancelConnect?.();
    this.cancelConnect = undefined;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null;
      previous.close();
    }
  }
  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
  async request(params: Record<string, unknown>): Promise<RpcResult> {
    if (this.state !== "online" || !navigator.onLine || !this.socket || this.socket.readyState !== WebSocket.OPEN || !this.sharedKey) throw new Error("Qahwa server is not connected");
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
    else {
      pending.resolve(envelope.result!);
      // An expired encrypted session gets a fresh handshake; a revoked device
      // is rejected there and returns to pairing without retaining the workspace.
      if (envelope.result?.status === 401) void this.connect().catch(() => undefined);
    }
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

export interface PendingAttachment extends ChatAttachment { progress: number }

async function uploadAttachment(
  mode: "task" | "orchestrator" | "draft",
  ownerId: string | undefined,
  file: File,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<ChatAttachment> {
  const checkCancelled = () => { if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError"); };
  checkCancelled();
  const base = mode === "draft" ? `/api/task-drafts/${encodeURIComponent(ownerId ?? "")}` : mode === "task" ? `/api/tasks/${encodeURIComponent(ownerId ?? "")}` : "/api/orchestrator";
  const initiated = await request<{ attachment: ChatAttachment & { chunkBytes: number } }>(`${base}/attachments`, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, mediaType: file.type || "application/octet-stream", size: file.size }),
  });
  const { attachment } = initiated;
  const discard = () => {
    void request<void>(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" }).catch(() => undefined);
  };
  signal?.addEventListener("abort", discard, { once: true });
  try {
    checkCancelled();
    const chunkBytes = attachment.chunkBytes;
    for (let offset = 0, chunk = 0; offset < file.size; offset += chunkBytes, chunk += 1) {
      checkCancelled();
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer());
      checkCancelled();
      const result = await client.request({
        path: `/api/attachments/${encodeURIComponent(attachment.id)}/chunks/${chunk}`,
        method: "PUT",
        bodyBase64: bytesToB64(bytes),
        headers: { "content-type": "application/octet-stream" },
      });
      if (result.status < 200 || result.status >= 300) {
        const body = (result.body ?? {}) as { message?: string; error?: string };
        throw new ApiError(body.message ?? "Chunk upload failed", body.error ?? "request_failed", result.status);
      }
      onProgress(file.size ? Math.round((Math.min(file.size, offset + bytes.length) / file.size) * 100) : 100);
    }
    checkCancelled();
    const completed = await request<{ attachment: ChatAttachment }>(`/api/attachments/${encodeURIComponent(attachment.id)}/complete`, { method: "POST" });
    checkCancelled();
    onProgress(100);
    return completed.attachment;
  } catch (error) {
    await request<void>(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  } finally { signal?.removeEventListener("abort", discard); }
}

export async function fetchEncryptedAsset(path: string): Promise<Blob> {
  const cached = assetCache.get(path);
  if (cached) return cached;
  const pending = fetchEncryptedAssetUncached(path);
  assetCache.set(path, pending);
  pending.catch(() => assetCache.delete(path));
  return pending;
}

export async function fetchEncryptedAttachment(path: string, size: number, mediaType: string): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  const chunkBytes = 256 * 1024;
  for (let offset = 0; offset < size; offset += chunkBytes) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await client.request({ path: `${path}${separator}offset=${offset}`, method: "GET" });
    if (result.status < 200 || result.status >= 300 || result.bodyBase64 === undefined) throw new ApiError("Attachment unavailable", "attachment_unavailable", result.status);
    chunks.push(b64ToBytes(result.bodyBase64));
  }
  if (size === 0) return new Blob([], { type: mediaType });
  const data = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) { data.set(chunk, cursor); cursor += chunk.length; }
  if (cursor !== size) throw new ApiError("Attachment transfer was incomplete", "attachment_size_mismatch", 409);
  return new Blob([data.buffer], { type: mediaType });
}

const assetCache = new Map<string, Promise<Blob>>();

// Binary files travel through the paired connection, never an unauthenticated URL.
// Keep each RPC bounded so large media does not create a single huge JSON frame.
export async function fetchMessageFile(path: string, options: { attachment?: boolean; size?: number; mediaType?: string; signal?: AbortSignal; limit?: number } = {}): Promise<Blob> {
  if (!/^\/api\/(?:tasks\/[^/]+\/(?:outputs\/[^/]+\/artifacts\/\d+|attachments\/[^/?]+|files\/[^/?]+)|orchestrator\/(?:attachments|files)\/[^/?]+)(?:\?[^#]*)?$/.test(path)) throw new Error("File URL is not supported");
  const chunks: ArrayBuffer[] = [];
  let total = options.size;
  let offset = 0;
  let mediaType = options.mediaType;
  const limit = options.limit ?? 250 * 1024 * 1024;
  const tooLarge = () => new Error(options.limit === undefined ? "File exceeds the 250 MiB download limit." : "File is too large for this preview. Use Download.");
  do {
    options.signal?.throwIfAborted();
    if (total !== undefined && total > limit) throw tooLarge();
    const result = await client.request({
      path: options.attachment ? `${path}${path.includes("?") ? "&" : "?"}offset=${offset}` : path,
      method: "GET", headers: options.attachment ? {} : { range: `bytes=${offset}-${offset + 256 * 1024 - 1}` },
    });
    options.signal?.throwIfAborted();
    if (result.status < 200 || result.status >= 300 || result.bodyBase64 === undefined) throw new Error("File unavailable. It may have expired or been removed.");
    mediaType ??= result.contentType;
    const range = result.contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (range) {
      if (Number(range[1]) !== offset) throw new Error("File transfer returned an invalid range");
      total = Number(range[3]);
    }
    const bytes = b64ToBytes(result.bodyBase64);
    if (offset + bytes.length > limit) throw tooLarge();
    if (!bytes.length && total !== 0) throw new Error("File transfer was incomplete");
    chunks.push(new Uint8Array(bytes).buffer);
    offset += bytes.length;
    if (result.status === 200 && !range) total ??= offset;
    if (total === undefined) throw new Error("File size is unavailable");
    if (offset > total) throw new Error("File transfer returned an invalid size");
  } while (offset < total);
  return new Blob(chunks, { type: mediaType ?? "application/octet-stream" });
}

async function fetchEncryptedAssetUncached(path: string): Promise<Blob> {
  const result = await client.request({ path, method: "GET" });
  if (result.status < 200 || result.status >= 300 || !result.bodyBase64) throw new ApiError("Asset unavailable", "asset_unavailable", result.status);
  const decoded = b64ToBytes(result.bodyBase64);
  const data = new Uint8Array(decoded.length);
  data.set(decoded);
  return new Blob([data.buffer], { type: result.contentType || "application/octet-stream" });
}

export const api = {
  createTerminal: (projectId: string, creationKey: string) => request<{ task: TaskDetail; terminal: TerminalView }>("/api/terminals", { method: "POST", body: JSON.stringify({ projectId, creationKey }) }),
  terminal: (id: string, generation?: string, cursor?: number, wait = false) => request<{ terminal: TerminalView }>(`/api/tasks/${encodeURIComponent(id)}/terminal?${new URLSearchParams({ ...(generation ? { generation } : {}), ...(cursor === undefined ? {} : { cursor: String(cursor) }), ...(wait ? { wait: "1" } : {}) })}`),
  terminalInput: (id: string, generation: string, inputId: string, data: string, binary = false, message?: string) => request<{ accepted: boolean }>(`/api/tasks/${encodeURIComponent(id)}/terminal/input`, { method: "POST", body: JSON.stringify({ generation, inputId, data, binary, message }) }),
  resizeTerminal: (id: string, generation: string, cols: number, rows: number) => request<{ resized: boolean }>(`/api/tasks/${encodeURIComponent(id)}/terminal/size`, { method: "PUT", body: JSON.stringify({ generation, cols, rows }) }),
  startTerminal: (id: string, generation?: string) => request<{ terminal: TerminalView }>(`/api/tasks/${encodeURIComponent(id)}/terminal/start`, { method: "POST", body: JSON.stringify({ generation }) }),
  terminalAction: (id: string, generation: string, action: "stop" | "close" | "restore") => request<{ terminal: TerminalView }>(`/api/tasks/${encodeURIComponent(id)}/terminal/${action}`, { method: "POST", body: JSON.stringify({ generation }) }),
  userAvatar: () => request<{ avatar: UserAvatar | null }>("/api/settings/avatar"),
  chatModels: () => request<{ models: ChatModelOption[] }>("/api/chat-models"),
  saveChatModel: (mode: "task" | "orchestrator", id: string | undefined, settings: ChatModelSelection) =>
    request<{ workspace: TaskWorkspace }>(mode === "task" ? `/api/tasks/${encodeURIComponent(id!)}/model` : "/api/orchestrator/model", {
      method: "PUT", body: JSON.stringify(settings),
    }),
  codexUsage: () => request<{ usage: CodexUsage }>("/api/settings/codex-usage"),
  userAvatarImage: (path: string) => fetchEncryptedAssetUncached(path),
  uploadUserAvatar: async (file: File): Promise<{ avatar: UserAvatar }> => {
    const result = await client.request({
      path: "/api/settings/avatar", method: "PUT", bodyBase64: bytesToB64(new Uint8Array(await file.arrayBuffer())),
      headers: { "content-type": file.type || "application/octet-stream" },
    });
    const body = (result.body ?? {}) as { avatar?: UserAvatar; message?: string; error?: string };
    if (result.status < 200 || result.status >= 300) throw new ApiError(body.message ?? "Avatar upload failed", body.error ?? "request_failed", result.status);
    return body as { avatar: UserAvatar };
  },
  resetUserAvatar: () => request<{ avatar: null }>("/api/settings/avatar", { method: "DELETE" }),
  orchestratorAvatar: () => request<{ avatar: UserAvatar | null }>("/api/settings/orchestrator/avatar"),
  orchestratorAvatarImage: (path: string) => fetchEncryptedAssetUncached(path),
  uploadOrchestratorAvatar: async (file: File): Promise<{ avatar: UserAvatar }> => {
    const result = await client.request({
      path: "/api/settings/orchestrator/avatar", method: "PUT", bodyBase64: bytesToB64(new Uint8Array(await file.arrayBuffer())),
      headers: { "content-type": file.type || "application/octet-stream" },
    });
    const body = (result.body ?? {}) as { avatar?: UserAvatar; message?: string; error?: string };
    if (result.status < 200 || result.status >= 300) throw new ApiError(body.message ?? "Avatar upload failed", body.error ?? "request_failed", result.status);
    return body as { avatar: UserAvatar };
  },
  resetOrchestratorAvatar: () => request<{ avatar: null }>("/api/settings/orchestrator/avatar", { method: "DELETE" }),
  orchestratorSettings: () => request<{ settings: OrchestratorSettings }>("/api/settings/orchestrator"),
  saveOrchestratorSettings: (settings: OrchestratorSettings) => request<{ settings: OrchestratorSettings }>("/api/settings/orchestrator", {
    method: "PUT", body: JSON.stringify(settings),
  }),
  clientDiagnostic: (category: string, message: string) => request<void>("/api/client-diagnostics", {
    method: "POST", body: JSON.stringify({ category, message, path: location.pathname }),
  }),
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
    `/api/tasks?tab=${tab}&order=conversation${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
  ),
  task: (id: string) => request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}`),
  editTask: (id: string, body: { title: string; description: RichTextDocument; expectedVersion: number }) => request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  editTaskMessage: (id: string, messageId: string, message: string, expectedVersion: number) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify({ message, expectedVersion }) }),
  editOrchestratorMessage: (messageId: string, message: string, expectedVersion: number) => request<{ workspace: TaskWorkspace }>(`/api/orchestrator/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify({ message, expectedVersion }) }),
  setTaskPinned: (id: string, pinned: boolean) => request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}/pin`, {
    method: "PUT", body: JSON.stringify({ pinned }),
  }),
  addCanvasComment: (id: string, body: RichTextDocument, canvas: CanvasCommentAnchor) => request(`/api/tasks/${encodeURIComponent(id)}/comments`, {
    method: "POST", body: JSON.stringify({ body, metadata: { canvas } }),
  }),
  resolveCanvasComment: (id: string, resolved: boolean) => request(`/api/comments/${encodeURIComponent(id)}/resolution`, {
    method: "POST", body: JSON.stringify({ resolved }),
  }),
  appPushSettings: () => request<{ publicKey: string; subscribed: boolean }>("/api/notifications/push"),
  saveAppPushSubscription: (subscription: PushSubscriptionJSON) => request<{ subscribed: boolean }>("/api/notifications/push", {
    method: "PUT", body: JSON.stringify(subscription),
  }),
  setIdleNotifications: (id: string, enabled: boolean) => request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}/idle-notifications`, {
    method: "PUT", body: JSON.stringify({ enabled }),
  }),
  createTask: (body: { projectId: string; title?: string; description: RichTextDocument; status: "backlog" | "todo"; draftId?: string; attachmentIds?: string[] }) =>
    request<{ task: TaskDetail }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  restoreTask: (id: string, expectedVersion: number) => request<{ task: TaskDetail }>(
    `/api/tasks/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ expectedVersion }) },
  ),
  transition: (id: string, to: TaskStatus, outcome?: "completed" | "cancelled", onlyIfUnstarted?: boolean) => request<{ task: TaskDetail }>(
    `/api/tasks/${id}/transition`, { method: "POST", body: JSON.stringify({ to, outcome, onlyIfUnstarted }) },
  ),
  reorder: (id: string, beforeId?: string | null, afterId?: string | null) => request<{ task: TaskDetail }>(
    `/api/tasks/${id}/reorder`, { method: "POST", body: JSON.stringify({ beforeId, afterId }) },
  ),
  workspacePoll: (id: string, cursor: WorkspaceCursor) => request<WorkspacePoll>(`/api/tasks/${encodeURIComponent(id)}/workspace?${new URLSearchParams({ poll: "1", ...cursor })}`),
  messagePage: (mode: "task" | "orchestrator", id: string | undefined, query: import("../domain/types").MessagePageQuery) =>
    request<{ page: import("../domain/types").MessagePage }>(`${mode === "task" ? `/api/tasks/${encodeURIComponent(id!)}` : "/api/orchestrator"}/messages?${new URLSearchParams({ ...query })}`),
  orchestratorPoll: (cursor: WorkspaceCursor) => request<WorkspacePoll & { capacity: { activeTurns: number; recommendedParallelism: number; availableSlots: number } }>(`/api/orchestrator?${new URLSearchParams({ poll: "1", ...cursor })}`),
  workspace: (id: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/workspace`),
  setTaskAccess: (id: string, mode: "read-only" | "worktree-write", expectedVersion: number) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/access`, { method: "PUT", body: JSON.stringify({ mode, expectedVersion }) }),
  saveSchedule: (id: string, body: { expectedVersion: number; localTime: string; timezone: string; policy: string }) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/schedule`, { method: "PUT", body: JSON.stringify(body) }),
  cancelSchedule: (id: string, expectedVersion: number) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/schedule/cancel`, { method: "POST", body: JSON.stringify({ expectedVersion }) }),
  triggerTask: (id: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/trigger`, { method: "POST" }),
  saveFollowup: (id: string, messageId: string, body: { expectedVersion: number; message: string; localTime: string; timezone: string; policy: string; designPageId?: string | null }) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/schedule`, { method: "PUT", body: JSON.stringify(body) }),
  cancelFollowup: (id: string, messageId: string, expectedVersion: number) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/schedule/cancel`, { method: "POST", body: JSON.stringify({ expectedVersion }) }),
  uploadAttachment,
  cancelTaskDraft: (id: string) => request<void>(`/api/task-drafts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  voiceAvailable: () => request<{ available: boolean }>("/api/voice-transcriptions/availability"),
  startVoiceTranscription: (mode: "task" | "orchestrator", taskId: string | undefined, attachmentId: string) => request<{ transcription: import("../domain/voice").VoiceTranscription }>(
    `${mode === "task" ? `/api/tasks/${encodeURIComponent(taskId ?? "")}` : "/api/orchestrator"}/voice/${encodeURIComponent(attachmentId)}/transcription`, { method: "POST" }),
  voiceTranscription: (id: string) => request<{ transcription: import("../domain/voice").VoiceTranscription }>(`/api/voice-transcriptions/${encodeURIComponent(id)}`),
  cancelVoiceTranscription: (id: string) => request<void>(`/api/voice-transcriptions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  removeAttachment: (id: string) => request<void>(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  sendTaskMessage: (id: string, message: string, attachmentIds: string[] = [], designPageId?: string | null, selectedExcerpt?: import("../domain/types").ChatExcerpt | null) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/messages`, {
    method: "POST", body: JSON.stringify({ message, attachmentIds, designPageId, selectedExcerpt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  }),
  cancelTaskMessage: (id: string, messageId: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/cancel`, { method: "POST" }),
  cancelOrchestratorMessage: (messageId: string) => request<{ workspace: TaskWorkspace }>(`/api/orchestrator/messages/${encodeURIComponent(messageId)}/cancel`, { method: "POST" }),
  runTaskMessageNow: (id: string, messageId: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/run-now`, { method: "POST" }),
  runOrchestratorMessageNow: (messageId: string) => request<{ workspace: TaskWorkspace }>(`/api/orchestrator/messages/${encodeURIComponent(messageId)}/run-now`, { method: "POST" }),
  interruptTask: (id: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/interrupt`, { method: "POST" }),
  createDesignPage: (id: string, name: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/design/pages`, { method: "POST", body: JSON.stringify({ name }) }),
  selectDesignPage: (id: string, pageId: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/design/pages/${encodeURIComponent(pageId)}/select`, { method: "POST" }),
  renameDesignPage: (id: string, pageId: string, name: string) => request<{ workspace: TaskWorkspace }>(`/api/tasks/${encodeURIComponent(id)}/design/pages/${encodeURIComponent(pageId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  orchestratorUnread: () => request<{ readState: ChatReadState; sessionState: import("../domain/types").SessionRunState }>("/api/orchestrator/unread"),
  taskUnread: (id: string) => request<{ readState: ChatReadState }>(`/api/tasks/${encodeURIComponent(id)}/unread`),
  markTaskRead: (id: string, messageIds: string[]) => request<{ readState: ChatReadState }>(`/api/tasks/${encodeURIComponent(id)}/read`, { method: "POST", body: JSON.stringify({ messageIds }) }),
  markOrchestratorRead: (messageIds: string[]) => request<{ readState: ChatReadState }>("/api/orchestrator/read", { method: "POST", body: JSON.stringify({ messageIds }) }),
  orchestrator: () => request<{ workspace: TaskWorkspace; capacity: { activeTurns: number; recommendedParallelism: number; availableSlots: number } }>("/api/orchestrator"),
  sendOrchestratorMessage: (message: string, attachmentIds: string[] = [], selectedTaskIds: string[] = [], selectedExcerpt?: import("../domain/types").ChatExcerpt | null) => request<{ workspace: TaskWorkspace }>("/api/orchestrator/messages", {
    method: "POST", body: JSON.stringify({ message, attachmentIds, selectedTaskIds, selectedExcerpt }),
  }),
  interruptOrchestrator: () => request<{ workspace: TaskWorkspace }>("/api/orchestrator/interrupt", { method: "POST" }),
  cleanOrchestrator: () => request<{ workspace: TaskWorkspace }>("/api/orchestrator/clean", { method: "POST" }),
  respondToRequest: (requestId: string, body: { approved?: boolean; answers?: Record<string, string> }) => request<{ resolved: boolean }>(
    `/api/session-requests/${encodeURIComponent(requestId)}/respond`, { method: "POST", body: JSON.stringify(body) },
  ),
  exportData: () => request<Record<string, unknown>>("/api/export"),
};
