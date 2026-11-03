import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertDomain, DomainError } from "../domain/errors.js";
import { VOICE_LIMITS, type VoiceTranscription } from "../domain/voice.js";
import type { PreparedAttachment } from "./attachment-service.js";

const runtime = join(homedir(), ".local/share/qahwa-tasks/voice");
type Runner = (command: string, args: string[], signal: AbortSignal, timeout: number) => Promise<void>;

// Whisper can hallucinate words on silence. Require 150 ms above -60 dBFS
// in the normalized PCM before inference; users still review every transcript.
function hasAudibleAudio(wav: Buffer): boolean {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, wav.length);
    if (wav.toString("ascii", offset, offset + 4) === "data") {
      let activeSamples = 0;
      for (let frame = start; frame + 1600 <= end; frame += 1600) {
        let energy = 0;
        for (let sample = frame; sample < frame + 1600; sample += 2) energy += wav.readInt16LE(sample) ** 2;
        if (energy / 800 > 33 ** 2) activeSamples += 800;
      }
      return activeSamples >= 2400;
    }
    offset = start + size + (size % 2);
  }
  return false;
}

export const runVoiceCommand: Runner = (command, args, signal, timeout) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { signal, killSignal: "SIGKILL", stdio: ["ignore", "ignore", "pipe"], shell: false });
  // Decoder/model diagnostics may contain private speech; never log them.
  child.stderr.resume();
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Voice processing failed or timed out")); });
});

interface Job {
  result: VoiceTranscription;
  deviceId: string;
  attachmentId: string;
  controller: AbortController;
  expires: number;
  work?: Promise<void>;
}

export class VoiceService {
  private readonly jobs = new Map<string, Job>();
  private readonly timer: NodeJS.Timeout;
  private active = false;
  private activeWork?: Promise<void>;
  private activeController?: AbortController;
  private readonly cli: string;
  private readonly model: string;
  constructor(private readonly options: { cli?: string; model?: string; run?: Runner; workDir?: string } = {}) {
    this.cli = options.cli ?? process.env.WHISPER_CLI ?? join(runtime, "whisper-cli");
    this.model = options.model ?? process.env.WHISPER_MODEL ?? join(runtime, "ggml-base.bin");
    this.timer = setInterval(() => {
      for (const [id, job] of this.jobs) if (job.expires <= Date.now()) { job.controller.abort(); this.jobs.delete(id); }
    }, 60_000);
    this.timer.unref();
  }

  async available(): Promise<boolean> {
    try { await Promise.all([access(this.cli, constants.X_OK), access(this.model, constants.R_OK)]); return true; }
    catch { return false; }
  }

  async start(attachment: PreparedAttachment, deviceId: string, cleanup?: () => void): Promise<VoiceTranscription> {
    assertDomain(attachment.size > 0 && attachment.size <= VOICE_LIMITS.bytes, "Recordings must be between 1 byte and 20 MiB", "invalid_voice_size", 413);
    assertDomain(/^audio\/(webm|mp4|ogg|wav|x-wav)(;.*)?$/i.test(attachment.mediaType), "Unsupported recording format", "invalid_voice_format", 415);
    // Return the same job if a start response was lost and the client retries.
    const existing = [...this.jobs.values()].find((job) => job.deviceId === deviceId && job.attachmentId === attachment.id);
    if (existing) return { ...existing.result };
    assertDomain(!this.active, "Another recording is being transcribed. Please retry shortly.", "voice_busy", 429);
    assertDomain(await this.available(), "Local transcription is unavailable. Please retry later or type your message.", "voice_unavailable", 503);
    // Recheck after the asynchronous availability check.
    assertDomain(!this.active, "Another recording is being transcribed. Please retry shortly.", "voice_busy", 429);
    assertDomain(this.jobs.size < 100, "Transcription capacity is full. Please retry shortly.", "voice_busy", 429);
    const result: VoiceTranscription = { id: randomUUID(), status: "processing" };
    const job: Job = { result, deviceId, attachmentId: attachment.id, controller: new AbortController(), expires: Date.now() + 20 * 60_000 };
    this.jobs.set(result.id, job);
    this.active = true;
    this.activeController = job.controller;
    job.work = this.process(attachment, job, cleanup);
    this.activeWork = job.work;
    return { ...result };
  }

  get(id: string, deviceId: string): VoiceTranscription { return { ...this.owned(id, deviceId).result }; }
  cancel(id: string, deviceId: string): void { this.owned(id, deviceId).controller.abort(); this.jobs.delete(id); }
  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    this.activeController?.abort();
    await this.activeWork;
    await Promise.all([...this.jobs.values()].map((job) => job.work));
    this.jobs.clear();
  }
  private owned(id: string, deviceId: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.deviceId !== deviceId) throw new DomainError("Transcription not found", "voice_not_found", 404);
    return job;
  }
  private async process(attachment: PreparedAttachment, job: Job, cleanup?: () => void): Promise<void> {
    let directory: string | undefined;
    let result = job.result;
    const signal = job.controller.signal;
    const run = this.options.run ?? runVoiceCommand;
    try {
      const workDir = this.options.workDir ?? tmpdir();
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(workDir, "qahwa-voice-"));
      signal.throwIfAborted();
      const wav = join(directory, "recording.wav");
      // Force an audio container: disguised playlists must not load other files or URLs.
      const format = attachment.mediaType.split(";", 1)[0]!.toLowerCase().split("/")[1]!;
      const demuxer = ({ webm: "matroska", mp4: "mov", ogg: "ogg", wav: "wav", "x-wav": "wav" } as Record<string, string>)[format]!;
      await run(process.env.FFMPEG_BIN ?? "ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer, "-i", attachment.path,
        "-map", "0:a:0", "-map_metadata", "-1", "-t", "301", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", wav], signal, 60_000);
      // PCM payload is 32,000 bytes/second. Allow only the WAV header overhead.
      const size = (await stat(wav)).size;
      assertDomain(size > 100 && size <= VOICE_LIMITS.seconds * 32000 + 100, "Recordings must contain audio and be at most five minutes", "invalid_voice_duration");
      assertDomain(hasAudibleAudio(await readFile(wav)), "No clear speech was detected. The recording may be silent or too quiet. Please record again.", "voice_no_speech");
      signal.throwIfAborted();
      const output = join(directory, "transcript");
      await run(this.cli, ["-m", this.model, "-f", wav, "-l", "auto", "-t", "2", "-ng", "-nt", "-otxt", "-of", output], signal, 10 * 60_000);
      signal.throwIfAborted();
      const text = (await readFile(`${output}.txt`, "utf8")).trim();
      assertDomain(text.length > 0 && text.length <= 50_000 && !/^\s*\[.*\]\s*$/.test(text), "No clear speech was detected. Please retry or type your message.", "voice_no_speech");
      result = { id: job.result.id, status: "complete", text };
    } catch (error) {
      result = { id: job.result.id, status: "failed", error: error instanceof DomainError ? error.message : "Could not transcribe this recording. Please retry or record again." };
    } finally {
      try { cleanup?.(); } catch { /* The client may already have removed its cancelled upload. */ }
      if (directory) await rm(directory, { recursive: true, force: true });
      this.active = false;
      job.result = result;
    }
  }
}
