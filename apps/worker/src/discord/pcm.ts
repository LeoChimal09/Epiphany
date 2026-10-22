// Audio helpers for live voice. Discord delivers 48 kHz stereo 16-bit PCM once Opus is decoded; a
// transcription service wants a small file, so it is turned into 16 kHz mono WAV.

export const PCM_RATE = 48_000;
export const PCM_CHANNELS = 2;
const BYTES_PER_FRAME = PCM_CHANNELS * 2;

// Seconds of audio in a buffer of 48 kHz stereo 16-bit PCM.
export function pcmSeconds(pcm: Uint8Array): number {
  return pcm.byteLength / (PCM_RATE * BYTES_PER_FRAME);
}

// Averages the channels and keeps every third sample (48 kHz to 16 kHz), then wraps the result in a
// WAV header. Speech survives this fine, and the upload is about a sixth of the size.
export function pcmToWav16kMono(pcm: Uint8Array): Uint8Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = Math.floor(pcm.byteLength / BYTES_PER_FRAME);
  const samples = Math.floor(frames / 3);
  const wav = new Uint8Array(44 + samples * 2);
  const out = new DataView(wav.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  out.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, 16_000, true);
  out.setUint32(28, 16_000 * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  write(36, "data");
  out.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const frame = i * 3 * BYTES_PER_FRAME;
    const left = view.getInt16(frame, true);
    const right = view.getInt16(frame + 2, true);
    out.setInt16(44 + i * 2, Math.round((left + right) / 2), true);
  }
  return wav;
}
