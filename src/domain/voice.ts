export const VOICE_LIMITS = { bytes: 20 * 1024 * 1024, seconds: 300 } as const;

export interface VoiceTranscription {
  id: string;
  status: "processing" | "complete" | "failed";
  text?: string;
  error?: string;
}
