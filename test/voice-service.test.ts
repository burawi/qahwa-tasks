import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VoiceService } from "../src/server/voice-service.js";
import type { PreparedAttachment } from "../src/server/attachment-service.js";
import type { VoiceTranscription } from "../src/domain/voice.js";
import { voiceWav } from "./helpers/voice.js";

async function fixture(options: { bytes?: number; text?: string; fail?: boolean; hold?: boolean; silent?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "voice-service-test-"));
  const model = join(directory, "model.bin");
  await writeFile(model, "test model");
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const workDir = join(directory, "private-scratch");
  const service = new VoiceService({ cli: process.execPath, model, workDir, run: async (_command, args, signal) => {
    calls.push(args);
    if (options.hold) await Promise.race([held, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    signal.throwIfAborted();
    if (options.fail) throw new Error("private diagnostic");
    if (args.includes("-otxt")) await writeFile(`${args[args.indexOf("-of") + 1]}.txt`, options.text ?? "Bonjour, مرحبا, hello.");
    else await writeFile(args.at(-1)!, voiceWav(options.bytes ?? 32078, options.silent));
  } });
  const attachment: PreparedAttachment = { id: "audio", filename: "voice.webm", mediaType: "audio/webm;codecs=opus", size: 100, status: "available", previewUrl: "/unused", path: join(directory, "audio") };
  return { service, attachment, calls, release, workDir };
}
async function finished(service: VoiceService, id: string): Promise<VoiceTranscription> {
  for (let i = 0; i < 200; i++) {
    const result = service.get(id, "device");
    if (result.status !== "processing") return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Test job did not complete");
}

test("local transcription auto-detects language, isolates files, limits CPU and cleans private audio", async () => {
  const { service, attachment, calls, workDir } = await fixture();
  let cleaned = false;
  try {
    const job = await service.start(attachment, "device", () => { cleaned = true; });
    assert.equal(job.status, "processing");
    assert.throws(() => service.get(job.id, "other-device"), /not found/);
    const result = await finished(service, job.id);
    assert.equal(result.text, "Bonjour, مرحبا, hello.");
    await service.close();
    assert.equal(cleaned, true);
    assert.ok(calls[0]!.includes("file,pipe"));
    assert.ok(calls[0]!.at(-1)!.startsWith(`${workDir}/`), "Decoder output uses the configured private scratch directory");
    assert.deepEqual(calls[1]!.slice(calls[1]!.indexOf("-l"), calls[1]!.indexOf("-l") + 4), ["-l", "auto", "-t", "2"]);
    await assert.rejects(stat(calls[0]!.at(-1)!), { code: "ENOENT" });
  } finally { await service.close(); }
});

test("voice limits reject oversize, wrong format and missing models before inference", async () => {
  const { service, attachment } = await fixture();
  try {
    await assert.rejects(service.start({ ...attachment, size: 20 * 1024 * 1024 + 1 }, "device"), /20 MiB/);
    await assert.rejects(service.start({ ...attachment, size: 0 }, "device"), /20 MiB/);
    await assert.rejects(service.start({ ...attachment, mediaType: "text/plain" }, "device"), /Unsupported/);
  } finally { await service.close(); }
  const absent = new VoiceService({ cli: "/no-such-voice-cli", model: "/no-such-model" });
  try { assert.equal(await absent.available(), false); await assert.rejects(absent.start(attachment, "device"), /unavailable/); }
  finally { await absent.close(); }
});

for (const [name, options, expected] of [
  ["overlong audio", { bytes: 301 * 32000 + 78 }, /five minutes/],
  ["empty audio", { bytes: 78 }, /contain audio/],
  ["silence", { text: "[BLANK_AUDIO]" }, /No clear speech/],
  ["silent PCM", { silent: true }, /No clear speech/],
  ["empty transcript", { text: "" }, /No clear speech/],
  ["decoder failure", { fail: true }, /Could not transcribe/],
] as const) test(`transcription reports ${name} without exposing process details`, async () => {
  const { service, attachment, calls } = await fixture(options);
  try {
    const job = await service.start(attachment, "device");
    const result = await finished(service, job.id);
    assert.equal(result.status, "failed");
    assert.match(result.error!, expected);
    assert.doesNotMatch(result.error!, /private diagnostic/);
    if (name === "overlong audio" || name === "empty audio") assert.equal(calls.length, 1);
  } finally { await service.close(); }
});

test("busy jobs reject competing work, repeated starts deduplicate and cancellation stops work", async () => {
  const { service, attachment } = await fixture({ hold: true });
  let cleaned = false;
  try {
    const job = await service.start(attachment, "device", () => { cleaned = true; });
    assert.equal((await service.start(attachment, "device")).id, job.id);
    await assert.rejects(service.start({ ...attachment, id: "another" }, "device"), /Another recording/);
    assert.throws(() => service.cancel(job.id, "other-device"), /not found/);
    service.cancel(job.id, "device");
    assert.throws(() => service.get(job.id, "device"), /not found/);
    await service.close();
    assert.equal(cleaned, true);
  } finally { await service.close(); }
});
