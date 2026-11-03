import assert from "node:assert/strict";
import test from "node:test";
import nacl from "tweetnacl";

const profileKey = "qahwa-tasks-pairing-v2";
const clientKeys = nacl.box.keyPair();
const serverKeys = nacl.box.keyPair();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const profile = { endpoint: "wss://fixture.invalid/rpc", deviceId: "fixture", deviceName: "Test", clientPublicKey: b64(clientKeys.publicKey), clientSecretKey: b64(clientKeys.secretKey), serverPublicKey: b64(serverKeys.publicKey) };
const storage = new Map([[profileKey, JSON.stringify(profile)]]);
const timers = new Map<number, { callback: () => void; delay: number }>();
let timerId = 0;
let online = true;
class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  authenticate() { this.open(); this.receive({ type: "challenge", challenge: "fixture" }); this.receive({ type: "ready" }); }
}
Object.defineProperties(globalThis, {
  localStorage: { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } },
  window: { configurable: true, value: { setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: (id: number) => timers.delete(id) } },
  navigator: { configurable: true, value: { get onLine() { return online; } } },
  WebSocket: { configurable: true, value: FakeSocket },
});
const { connection, api } = await import("../src/web/api.js");
const latest = () => FakeSocket.sockets.at(-1)!;
const connect = async () => { const attempt = connection.connect(); latest().authenticate(); await attempt; };
const runTimer = (select: (delay: number) => boolean) => {
  const entry = [...timers].find(([, timer]) => select(timer.delay));
  assert.ok(entry); timers.delete(entry[0]); entry[1].callback();
};
const reset = () => { connection.disconnect(); storage.set(profileKey, JSON.stringify(profile)); online = true; };

test("a stored device starts connecting without an initial pairing state", () => {
  assert.equal(connection.state(), "connecting");
});
test("transport loss retains credentials, retries, and rejects sends until authenticated", async () => {
  reset(); await connect();
  latest().close();
  assert.equal(connection.state(), "offline"); assert.ok(storage.has(profileKey));
  await assert.rejects(api.projects(), /not connected/);
  runTimer(delay => delay < 4000);
  assert.equal(connection.state(), "connecting");
  latest().open(); latest().receive({ type: "challenge", challenge: "retry" });
  await assert.rejects(api.projects(), /not connected/);
  latest().receive({ type: "ready" });
  assert.equal(connection.state(), "online");
});
test("error, early close, and timeout settle connection attempts and preserve pairing", async () => {
  for (const reason of ["error", "close", "timeout"]) {
    reset(); const attempt = connection.connect(); const rejected = assert.rejects(attempt);
    if (reason === "error") latest().onerror?.();
    else if (reason === "close") latest().close();
    else runTimer(delay => delay === 10_000);
    await rejected;
    assert.equal(connection.state(), "offline"); assert.ok(storage.has(profileKey));
    assert.equal([...timers.values()].filter(timer => timer.delay < 4000).length, 1);
  }
});
test("replacing or disconnecting a handshake settles it and ignores stale callbacks", async () => {
  reset(); const first = connection.connect(); const rejected = assert.rejects(first, /replaced/);
  const old = latest(); const staleMessage = old.onmessage!; const staleClose = old.onclose!;
  await connect(); await rejected;
  staleClose(); staleMessage({ data: JSON.stringify({ type: "error", message: "Authentication failed" }) });
  assert.equal(connection.state(), "online"); assert.ok(storage.has(profileKey));
  const waiting = connection.connect(); const cancelled = assert.rejects(waiting, /replaced/);
  connection.disconnect(); await cancelled;
  assert.equal(connection.state(), "unpaired"); assert.equal(timers.size, 0);
});
test("invalid or revoked credentials require pairing and stop automatic retries", async () => {
  for (const message of ["Unknown or revoked device", "Authentication failed"]) {
    reset(); const attempt = connection.connect(); const rejected = assert.rejects(attempt, new RegExp(message));
    latest().open(); latest().receive({ type: "error", message }); await rejected;
    assert.equal(connection.state(), "unpaired"); assert.equal(storage.has(profileKey), false); assert.equal(timers.size, 0);
  }
});
test("reconnect rejects pending RPCs; native offline status also prevents sending", async () => {
  reset(); await connect();
  const pending = api.projects(); const rejected = assert.rejects(pending, /replaced/);
  await connect(); await rejected;
  assert.equal([...timers.values()].some(timer => timer.delay === 120_000), false);
  online = false; await assert.rejects(api.projects(), /not connected/);
});
test("an expired session reconnects before deciding whether pairing is required", async () => {
  reset(); await connect();
  const socket = latest(); const pending = api.projects(); const rejected = assert.rejects(pending, /expired/);
  const frame = socket.sent.at(-1)!;
  const shared = nacl.box.before(clientKeys.publicKey, serverKeys.secretKey);
  const opened = nacl.secretbox.open(Buffer.from(String(frame.payload), "base64"), Buffer.from(String(frame.nonce), "base64"), shared)!;
  const { id } = JSON.parse(Buffer.from(opened).toString());
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  socket.receive({ type: "box", nonce: b64(nonce), payload: b64(nacl.secretbox(Buffer.from(JSON.stringify({ id, result: { status: 401, body: { error: "session_expired", message: "Session expired" } } })), nonce, shared)) });
  await rejected;
  assert.equal(connection.state(), "connecting"); assert.ok(storage.has(profileKey));
  latest().authenticate(); assert.equal(connection.state(), "online");
});
test("missing or malformed pairing profiles do not attempt a connection", async () => {
  for (const value of ["null", "{}", "broken-json", JSON.stringify({ ...profile, clientSecretKey: "invalid" })]) {
    reset(); storage.set(profileKey, value); const before = FakeSocket.sockets.length;
    await connection.connect();
    assert.equal(connection.state(), "unpaired"); assert.equal(FakeSocket.sockets.length, before);
  }
  connection.disconnect();
});
