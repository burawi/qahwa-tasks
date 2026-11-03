/** Small PCM fixture for exercising the real WAV guard without an inference engine. */
export function voiceWav(bytes = 32078, silent = false): Buffer {
  const wav = Buffer.alloc(bytes);
  if (bytes < 44) return wav;
  wav.write("RIFF", 0); wav.writeUInt32LE(bytes - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(bytes - 44, 40);
  if (!silent) for (let i = 44; i + 2 <= bytes; i += 2) wav.writeInt16LE(Math.round(Math.sin(i / 16) * 3000), i);
  return wav;
}
