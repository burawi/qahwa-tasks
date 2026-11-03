import assert from "node:assert/strict";
import test from "node:test";
import { coordinationFixture, until } from "./helpers/orchestrator-replies.js";
import { workspacePoll } from "../src/server/workspace-poll.js";

const authorization = "Send guidance to the task";
const envelope = (actions: unknown[]) => `I'll arrange the requested guidance.\n<!-- qahwa-actions:${JSON.stringify(actions)} -->`;
type Fixture = ReturnType<typeof coordinationFixture>;
const guide = (f: Fixture, id: string, key?: string) => Reflect.get(f.agents, "messageTask").call(f.agents, id, "Keep the authorized scope", null, key) as Promise<{ status: string; message: string }>;
const drain = (f: Fixture) => Reflect.get(f.agents, "drainPendingMessages").call(f.agents) as Promise<void>;
const messages = (f: Fixture, id: string) => f.agents.workspace("task", id).messages;
const receipt = (f: Fixture, id: string) => messages(f, id).at(-1)!.guidanceDeliveries![0]!;
const pending = (f: Fixture, id: string) => f.database.db.prepare("SELECT 1 FROM pending_messages WHERE message_id=?").get(id);
async function complete(f: Fixture, ownerType: "task" | "orchestrator", ownerId: string) {
  const { threadId, activeTurnId } = f.agents.workspace(ownerType, ownerId).session;
  f.emit([{ method: "turn/completed", params: { threadId, turn: { id: activeTurnId, status: "completed" } } }]);
  await until(() => Boolean(f.database.db.prepare("SELECT 1 FROM session_events WHERE event_type='turn/completed' AND turn_id=?").get(activeTurnId)), "Turn completion was not received");
}

test("steering requires the intended active turn and one durable message; both chats share its receipt", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect");
    const expected = f.agents.workspace("task", task.id).session.activeTurnId;
    f.settings({ delay: 150 });
    await f.reply(envelope([{ type: "message", taskId: task.humanId, message: "Keep the authorized scope", authorization }]), authorization);
    await until(() => Boolean(messages(f, task.id).at(-1)?.guidanceDeliveries?.length), "Receipt not saved");
    assert.equal(receipt(f, task.id).status, "pending");
    const before = f.workspace(), cursor = workspacePoll(before, {});
    assert.equal(before.messages.at(-1)!.guidanceDeliveries![0]!.status, "pending");
    await until(() => receipt(f, task.id).status === "delivered", "Acknowledgement not recorded");
    const requests = f.requests().filter(r => r.method === "turn/steer");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.params.expectedTurnId, expected);
    assert.equal(receipt(f, task.id).turnId, expected);
    assert.equal(messages(f, task.id).length, 2, "One original message and one guidance message");
    assert.equal(pending(f, receipt(f, task.id).messageId), undefined);
    assert.deepEqual(f.workspace().messages.at(-1)!.guidanceDeliveries, [receipt(f, task.id)]);
    assert.notEqual(workspacePoll(f.workspace(), cursor).messagesRevision, cursor.messagesRevision);
  } finally { f.close(); }
});

test("the transport fixture rejects a missing expectedTurnId instead of accepting invalid steering", async () => {
  const f = coordinationFixture();
  try {
    await Reflect.get(f.agents, "codex").initialize();
    await assert.rejects(Reflect.get(f.agents, "codex").request("turn/steer", { threadId: "thread", input: [] }), /missing field expectedTurnId/);
  } finally { f.close(); }
});

for (const state of ["running", "waiting"] as const) {
  test(`${state} session without an active identifier saves guidance until its turn ends`, async () => {
    const f = coordinationFixture();
    try {
      const task = f.task();
      await f.agents.send("task", task.id, "Inspect");
      const session = f.agents.workspace("task", task.id).session;
      f.database.db.prepare("UPDATE agent_sessions SET run_state=?,active_turn_id=NULL WHERE id=?").run(state, session.id);
      assert.equal((await guide(f, task.id)).status, "queued");
      assert.equal(receipt(f, task.id).status, "pending");
      assert.ok(pending(f, receipt(f, task.id).messageId));
      assert.equal(f.requests().some(r => r.method === "turn/steer"), false);
      f.emit([{ method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.activeTurnId, status: "completed" } } }]);
      await until(() => receipt(f, task.id).status === "delivered", "Retained guidance never started");
      assert.equal(f.requests().filter(r => r.method === "turn/start").length, 2);
      assert.equal(messages(f, task.id).length, 2);
    } finally { f.close(); }
  });
}

for (const currentTurnId of [null, "replacement-turn"]) {
  test(`a ${currentTurnId ? "stale" : "finished"} active turn rejection retains the same guidance for a later turn`, async () => {
    const f = coordinationFixture();
    try {
      const task = f.task();
      await f.agents.send("task", task.id, "Inspect");
      f.settings({ currentTurnId });
      assert.equal((await guide(f, task.id)).status, "queued");
      assert.match(receipt(f, task.id).detail, /turn changed or ended/);
      await drain(f);
      assert.equal(f.requests().filter(r => r.method === "turn/steer").length, 1, "Do not blindly steer the replacement turn");
      const id = receipt(f, task.id).messageId;
      await complete(f, "task", task.id);
      await until(() => receipt(f, task.id).status === "delivered", "Queued guidance did not start");
      assert.equal(receipt(f, task.id).messageId, id);
      assert.equal(messages(f, task.id).length, 2);
      assert.equal(f.requests().filter(r => r.method === "turn/start").length, 2);
    } finally { f.close(); }
  });
}

test("an accepted steer acknowledgement remains delivered when its turn finishes before the reply arrives", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect");
    const intended = f.agents.workspace("task", task.id).session.activeTurnId;
    f.settings({ delay: 150 });
    const delivering = guide(f, task.id);
    await until(() => f.requests().some(r => r.method === "turn/steer"), "Steer not received");
    await complete(f, "task", task.id);
    assert.equal((await delivering).status, "applied");
    assert.equal(receipt(f, task.id).turnId, intended);
    await drain(f);
    assert.equal(f.requests().filter(r => r.method === "turn/start").length, 1);
  } finally { f.close(); }
});

test("a definitely rejected request is failed, retained across restart, and never automatically retried", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect");
    f.settings({ reject: "turn/steer", rejectCode: -32602, rejectMessage: "Invalid input" });
    assert.equal((await guide(f, task.id)).status, "failed");
    assert.equal(receipt(f, task.id).uncertain, false);
    assert.match(receipt(f, task.id).detail, /Saved; request rejected/);
    const saved = receipt(f, task.id);
    f.restart();
    await drain(f);
    assert.deepEqual(receipt(f, task.id), saved);
    assert.ok(pending(f, saved.messageId));
    assert.equal(f.requests().filter(r => r.method === "turn/steer").length, 1);
    assert.equal(f.requests().filter(r => r.method === "turn/start").length, 1);
  } finally { f.close(); }
});

for (const settings of [{ disconnect: true }, { ackTurnId: "wrong-turn" }, { reject: "turn/steer", rejectCode: -32603 }]) {
  test(`uncertain steering ${JSON.stringify(settings)} blocks blind retry`, async () => {
    const f = coordinationFixture();
    try {
      const task = f.task();
      await f.agents.send("task", task.id, "Inspect");
      f.settings(settings);
      assert.equal((await guide(f, task.id)).status, "failed");
      assert.equal(receipt(f, task.id).uncertain, true);
      const id = receipt(f, task.id).messageId;
      f.restart();
      await f.reply(envelope([{ type: "dispatch", messageIds: [id], authorization }]), authorization);
      await until(() => f.assistants().at(-1)?.body.includes("Guidance delivery is uncertain") ?? false, "Uncertain retry was not blocked");
      assert.equal(receipt(f, task.id).status, "failed");
      assert.ok(pending(f, id));
      assert.equal(f.requests().filter(r => r.method === "turn/steer").length, 1);
    } finally { f.close(); }
  });
}

test("replaying the same guidance action cannot duplicate execution or the saved task note", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect");
    f.settings({ delay: 100 });
    const first = guide(f, task.id, "stable-action");
    assert.equal((await guide(f, task.id, "stable-action")).status, "queued");
    assert.equal((await first).status, "applied");
    assert.equal((await guide(f, task.id, "stable-action")).status, "applied");
    assert.equal(messages(f, task.id).length, 2);
    assert.equal(f.requests().filter(r => r.method === "turn/steer").length, 1);
  } finally { f.close(); }
});

test("queued guidance survives restart and is delivered exactly once with a new turn", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    f.agents.limit = 0;
    assert.equal((await guide(f, task.id)).status, "queued");
    const saved = receipt(f, task.id).messageId;
    f.restart();
    await drain(f);
    assert.equal(receipt(f, task.id).status, "delivered");
    assert.equal(receipt(f, task.id).messageId, saved);
    await drain(f);
    assert.equal(f.requests().filter(r => r.method === "turn/start").length, 1);
    assert.equal(messages(f, task.id).length, 1);
  } finally { f.close(); }
});

for (const phase of ["steer", "start"] as const) {
  test(`restart with ${phase} in flight retains intent as uncertain without redelivery`, async () => {
    const f = coordinationFixture();
    try {
      const task = f.task();
      f.agents.limit = 0;
      await guide(f, task.id);
      f.database.db.prepare("UPDATE guidance_deliveries SET phase=? WHERE task_id=?").run(phase, task.id);
      f.restart();
      await drain(f);
      assert.equal(receipt(f, task.id).status, "failed");
      assert.equal(receipt(f, task.id).uncertain, true);
      assert.ok(pending(f, receipt(f, task.id).messageId));
      assert.equal(f.requests().filter(r => r.method === "turn/start").length, 0);
    } finally { f.close(); }
  });
}

test("new-turn rejection retains guidance and waits for explicit retry of that same message", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    f.settings({ reject: "turn/start", rejectCode: -32602 });
    assert.equal((await guide(f, task.id)).status, "failed");
    const id = receipt(f, task.id).messageId;
    f.settings({});
    await f.reply(envelope([{ type: "dispatch", messageIds: [id] }]), "Inspect the failure");
    await until(() => f.assistants().at(-1)?.body.includes("explicit retry authorization") ?? false, "Automatic retry not blocked");
    assert.equal(receipt(f, task.id).status, "failed");
    await complete(f, "orchestrator", "main");
    const retry = "Retry the rejected guidance";
    await f.reply(envelope([{ type: "dispatch", messageIds: [id], authorization: retry }]), retry);
    await until(() => receipt(f, task.id).status === "pending", "Explicit retry was not queued");
    await complete(f, "orchestrator", "main");
    await until(() => receipt(f, task.id).status === "delivered", "Retry was not delivered");
    assert.equal(receipt(f, task.id).messageId, id);
    assert.equal(messages(f, task.id).length, 1);
  } finally { f.close(); }
});

for (const eventTurn of ["intended", "different"]) {
  test(`a correlated input event for the ${eventTurn} turn reconciles only the matching delivery`, async () => {
    const f = coordinationFixture();
    try {
      const task = f.task();
      await f.agents.send("task", task.id, "Inspect");
      const { threadId, activeTurnId } = f.agents.workspace("task", task.id).session;
      f.settings({ reject: "turn/steer", rejectCode: -32603 });
      await guide(f, task.id);
      const id = receipt(f, task.id).messageId;
      const turnId = eventTurn === "intended" ? activeTurnId : "different-turn";
      f.emit([{ method: "item/completed", params: { threadId, turnId, item: { type: "userMessage", id: "observed-input", clientId: id, content: [] } } }]);
      await until(() => Boolean(f.database.db.prepare("SELECT 1 FROM session_events WHERE event_type='item/completed' AND turn_id=?").get(turnId)), "Input event not recorded");
      assert.equal(receipt(f, task.id).status, eventTurn === "intended" ? "delivered" : "failed");
      assert.equal(Boolean(pending(f, id)), eventTurn !== "intended");
      await drain(f);
      assert.equal(f.requests().filter(r => r.method === "turn/steer").length, 1);
    } finally { f.close(); }
  });
}

test("a turn-start disconnect retains guidance as uncertain and never starts it again", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    f.settings({ reject: "turn/start", rejectCode: -32603, rejectMessage: "Response lost" });
    assert.equal((await guide(f, task.id)).status, "failed");
    assert.equal(receipt(f, task.id).uncertain, true);
    await drain(f);
    assert.equal(f.requests().filter(r => r.method === "turn/start").length, 1);
  } finally { f.close(); }
});

test("failure before turn/start is retained without claiming an ambiguous delivery", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    f.settings({ reject: "thread/start", rejectCode: -32602 });
    assert.equal((await guide(f, task.id)).status, "failed");
    assert.equal(receipt(f, task.id).uncertain, false);
    assert.ok(pending(f, receipt(f, task.id).messageId));
    assert.equal(f.requests().some(r => r.method === "turn/start"), false);
  } finally { f.close(); }
});

test("a protocol schema rejection is failed rather than mistaken for an ended turn", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    await f.agents.send("task", task.id, "Inspect");
    f.settings({ reject: "turn/steer", rejectCode: -32600, rejectMessage: "Invalid request: missing field expectedTurnId" });
    assert.equal((await guide(f, task.id)).status, "failed");
    assert.equal(receipt(f, task.id).uncertain, false);
    assert.match(receipt(f, task.id).detail, /request rejected/);
  } finally { f.close(); }
});

test("legacy guidance text is shown as saved and unconfirmed without being replayed", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    const id = Reflect.get(f.agents, "addMessage").call(f.agents, "task", task.id, "system", "Labib guidance: Deploy the already authorized change");
    assert.equal(receipt(f, task.id).status, "saved");
    assert.equal(receipt(f, task.id).uncertain, true);
    assert.match(receipt(f, task.id).detail, /Delivery is unconfirmed/);
    assert.equal(pending(f, id), undefined);
    await drain(f);
    assert.equal(f.requests().length, 0);
  } finally { f.close(); }
});

test("a queued guidance receipt updates the original orchestrator reply after later delivery", async () => {
  const f = coordinationFixture();
  try {
    const task = f.task();
    f.agents.limit = 0;
    await f.reply(envelope([{ type: "message", taskId: task.humanId, message: "Keep the authorized scope", authorization }]), authorization);
    await until(() => f.assistants().at(-1)?.body.includes("was saved for delivery") ?? false, "Queued guidance was not reported");
    const source = f.assistants().at(-1)!;
    assert.equal(source.guidanceDeliveries![0]!.status, "pending");
    f.agents.limit = 4;
    await complete(f, "orchestrator", "main");
    await until(() => receipt(f, task.id).status === "delivered", "Guidance was not delivered later");
    const after = f.assistants().find(m => m.id === source.id)!;
    assert.equal(after.guidanceDeliveries![0]!.status, "delivered");
    assert.match(after.body, /receipt shows its current status/);
    assert.doesNotMatch(after.body, /is saved and waiting/);
    assert.equal(messages(f, task.id).length, 1);
  } finally { f.close(); }
});
