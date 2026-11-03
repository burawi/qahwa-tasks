import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VoiceService, runVoiceCommand } from "../src/server/voice-service.js";
import type { PreparedAttachment } from "../src/server/attachment-service.js";

const sample = process.env.VOICE_REAL_AUDIO;
test("real local engine transcribes browser audio and supported containers; rejects silence, bad data and long audio", { skip: !sample, timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "qahwa-voice-real-"));
  const voice = new VoiceService();
  let serial = 0;
  const run = (args: string[]) => runVoiceCommand("ffmpeg", ["-nostdin", "-v", "error", ...args], new AbortController().signal, 30_000);
  const transcribe = async (path: string, mediaType: string) => {
    const attachment: PreparedAttachment = { id: `real-${++serial}`, filename: "voice", mediaType, size: (await stat(path)).size, status: "available", previewUrl: "/unused", path };
    const job = await voice.start(attachment, "device");
    for (let i = 0; i < 1200; i++) {
      const result = voice.get(job.id, "device");
      if (result.status !== "processing") {
        // Finish asynchronous file cleanup before the next inference.
        await new Promise(resolve => setTimeout(resolve, 50));
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Real transcription did not finish");
  };
  try {
    assert.equal(await voice.available(), true);
    const recorded = await transcribe(sample!, "audio/webm");
    assert.equal(recorded.status, "complete", recorded.error);
    assert.match(recorded.text!, /fellow American/i);
    for (const [extension, mediaType, codec] of [["ogg", "audio/ogg", "libopus"], ["m4a", "audio/mp4", "aac"], ["wav", "audio/wav", "pcm_s16le"]]) {
      const path = join(directory, `converted.${extension}`);
      await run(["-i", sample!, "-c:a", codec!, path]);
      const result = await transcribe(path, mediaType!);
      assert.equal(result.status, "complete", result.error); assert.match(result.text!, /fellow American/i);
    }
    const silence = join(directory, "silence.wav");
    await run(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3", "-c:a", "pcm_s16le", silence]);
    const silent = await transcribe(silence, "audio/wav");
    assert.equal(silent.status, "failed", JSON.stringify(silent));
    const long = join(directory, "long.wav");
    await run(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "301", "-c:a", "pcm_s16le", long]);
    assert.match((await transcribe(long, "audio/wav")).error!, /five minutes/);
    const invalid = join(directory, "playlist"); await writeFile(invalid, "#EXTM3U\nfile:///etc/passwd\n");
    assert.equal((await transcribe(invalid, "audio/webm")).status, "failed");
    console.log(JSON.stringify({ realAudio: sample, transcript: recorded.text, containers: ["webm", "ogg", "mp4", "wav"], rejected: ["silence", "overlong", "disguised playlist"] }));
  } finally { await voice.close(); }
});
