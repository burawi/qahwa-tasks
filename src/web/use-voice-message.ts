import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_LIMITS } from "../domain/voice";
import { api, ApiError } from "./api";

type Phase = "idle" | "requesting" | "recording" | "processing" | "review" | "error";
interface Operation {
  cancelled: boolean;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: number;
  limit?: number;
  blob?: Blob;
  attachmentId?: string;
  jobId?: string;
  url?: string;
  wake?: () => void;
  processing?: boolean;
}
const release = (op: Operation) => {
  window.clearInterval(op.timer);
  window.clearTimeout(op.limit);
  if (op.recorder && op.recorder.state !== "inactive") op.recorder.stop();
  op.stream?.getTracks().forEach((track) => track.stop());
};
const dispose = (op: Operation) => {
  op.cancelled = true;
  release(op);
  op.wake?.();
  if (op.url) URL.revokeObjectURL(op.url);
  if (op.jobId) void api.cancelVoiceTranscription(op.jobId).catch(() => undefined);
  if (op.attachmentId) void api.removeAttachment(op.attachmentId).catch(() => undefined);
};

export function useVoiceMessage(mode: "task" | "orchestrator", taskId?: string) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [preview, setPreview] = useState<string>();
  const operation = useRef<Operation | null>(null);
  const supported = typeof window !== "undefined" && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
  const cancel = useCallback(() => {
    if (operation.current) dispose(operation.current);
    operation.current = null;
    setPhase("idle"); setError(""); setTranscript(""); setPreview(undefined); setSeconds(0);
  }, []);
  useEffect(() => {
    cancel();
    const onPageHide = () => cancel();
    window.addEventListener("pagehide", onPageHide);
    return () => { window.removeEventListener("pagehide", onPageHide); if (operation.current) dispose(operation.current); operation.current = null; };
  }, [mode, taskId, cancel]);

  const transcribe = async (op: Operation) => {
    if (!op.blob || op.cancelled || op.processing) return;
    op.processing = true;
    setPhase("processing"); setError("");
    try {
      const ext = op.blob.type.includes("mp4") ? "m4a" : op.blob.type.includes("ogg") ? "ogg" : "webm";
      if (!op.attachmentId) {
        const attachment = await api.uploadAttachment(mode, taskId, new File([op.blob], `voice.${ext}`, { type: op.blob.type }), () => {});
        op.attachmentId = attachment.id;
      }
      if (op.cancelled) { void api.removeAttachment(op.attachmentId).catch(() => undefined); return; }
      let { transcription } = op.jobId ? await api.voiceTranscription(op.jobId) : await api.startVoiceTranscription(mode, taskId, op.attachmentId);
      op.jobId = transcription.id;
      if (op.cancelled) { void api.cancelVoiceTranscription(op.jobId).catch(() => undefined); return; }
      const deadline = Date.now() + 12 * 60_000;
      while (transcription.status === "processing") {
        if (Date.now() > deadline) throw new Error("Transcription timed out. Please retry.");
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 1000);
          op.wake = () => { window.clearTimeout(timer); resolve(); };
        });
        if (op.cancelled) return;
        ({ transcription } = await api.voiceTranscription(op.jobId));
        if (op.cancelled) return;
      }
      if (transcription.status === "failed") {
        await api.cancelVoiceTranscription(op.jobId).catch(() => undefined);
        op.jobId = undefined;
        await api.removeAttachment(op.attachmentId).catch(() => undefined);
        op.attachmentId = undefined;
        throw new Error(transcription.error || "Transcription failed. Please retry.");
      }
      setTranscript(transcription.text ?? ""); setPhase("review");
      // Only the text is sent. Retain audio locally for review, delete the uploaded copy.
      void api.removeAttachment(op.attachmentId).catch(() => undefined);
      op.attachmentId = undefined;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "voice_not_found") op.jobId = undefined;
      // A lost start response or an expired upload must not trap Retry on a stale ID.
      if (!op.jobId && op.attachmentId) {
        void api.removeAttachment(op.attachmentId).catch(() => undefined);
        op.attachmentId = undefined;
      }
      if (!op.cancelled) { setError(cause instanceof Error ? cause.message : "Could not transcribe the recording"); setPhase("error"); }
    } finally {
      op.processing = false;
    }
  };
  const stop = () => { const op = operation.current; if (op) release(op); };
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        const op = operation.current;
        if (op?.recorder?.state === "recording") release(op);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);

  const start = async () => {
    if (!supported || operation.current) return;
    const op: Operation = { cancelled: false };
    operation.current = op;
    setPhase("requesting"); setError(""); setSeconds(0);
    try {
      const status = await api.voiceAvailable();
      if (op.cancelled) return;
      if (!status.available) throw new Error("Local transcription is unavailable. Please retry later or type your message.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      op.stream = stream;
      if (op.cancelled) { release(op); return; }
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      op.recorder = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      let tooLarge = false;
      let recordingError = false;
      recorder.ondataavailable = (event) => {
        if (op.cancelled || tooLarge) return;
        bytes += event.data.size;
        if (bytes > VOICE_LIMITS.bytes) { tooLarge = true; chunks.length = 0; release(op); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => { recordingError = true; release(op); if (!op.cancelled) { setError("Recording was interrupted. Please record again."); setPhase("error"); } };
      recorder.onstop = () => {
        release(op);
        if (op.cancelled || recordingError) return;
        if (tooLarge || !bytes) { setError(tooLarge ? "Recording exceeds 20 MiB. Please record a shorter message." : "No audio was recorded. Please try again."); setPhase("error"); return; }
        op.blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        op.url = URL.createObjectURL(op.blob); setPreview(op.url);
        void transcribe(op);
      };
      recorder.start(500);
      setPhase("recording");
      const started = Date.now();
      op.timer = window.setInterval(() => setSeconds(Math.min(VOICE_LIMITS.seconds, Math.floor((Date.now() - started) / 1000))), 250);
      op.limit = window.setTimeout(() => release(op), VOICE_LIMITS.seconds * 1000);
    } catch (cause) {
      release(op);
      if (op.cancelled) return;
      const name = cause instanceof DOMException ? cause.name : "";
      setError(name === "NotAllowedError" || name === "SecurityError" ? "Microphone access was denied. Allow it in your browser settings, then record again."
        : name === "NotFoundError" ? "No microphone was found. Connect one and record again."
        : cause instanceof Error ? cause.message : "Could not start recording. Please try again.");
      setPhase("error");
    }
  };
  return { phase, seconds, error, transcript, setTranscript, preview, supported, start, stop, cancel,
    retry: () => { if (operation.current?.blob) void transcribe(operation.current); else { cancel(); void start(); } },
    blocked: phase !== "idle" && phase !== "review",
  };
}
