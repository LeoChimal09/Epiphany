import { describe, expect, it } from "vitest";
import { PCM_RATE, pcmSeconds, pcmToWav16kMono } from "./pcm";

function stereo(frames: number, left: number, right: number): Uint8Array {
  const buffer = new Uint8Array(frames * 4);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, left, true);
    view.setInt16(i * 4 + 2, right, true);
  }
  return buffer;
}

describe("voice audio helpers", () => {
  it("measures seconds of 48 kHz stereo audio", () => {
    expect(pcmSeconds(stereo(PCM_RATE, 0, 0))).toBe(1);
    expect(pcmSeconds(new Uint8Array(0))).toBe(0);
  });

  it("makes a valid 16 kHz mono WAV, averaging the channels", () => {
    const wav = pcmToWav16kMono(stereo(PCM_RATE, 1000, 3000));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(16_000 * 2);
    expect(wav.byteLength).toBe(44 + 16_000 * 2);
    expect(view.getInt16(44, true)).toBe(2000);
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  });

  it("handles an empty or tiny recording", () => {
    expect(pcmToWav16kMono(new Uint8Array(0)).byteLength).toBe(44);
    expect(pcmToWav16kMono(stereo(2, 5, 5)).byteLength).toBe(44);
  });
});
