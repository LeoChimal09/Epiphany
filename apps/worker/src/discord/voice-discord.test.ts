import { describe, expect, it } from "vitest";
import { loadVoiceConfig } from "@epiphany/core/voice";
import { downloadAudio, isAffirmative, pickAudioAttachment } from "./voice-discord";

const att = (over: Record<string, unknown>) => ({
  url: "https://cdn.example/a",
  name: "a",
  size: 1000,
  contentType: "audio/ogg",
  ...over,
});
const config = loadVoiceConfig({ OPENAI_API_KEY: "k", AUDIO_MAX_BYTES: "100" });

describe("Discord audio attachments", () => {
  it("picks the first audio attachment and ignores images and documents", () => {
    const list = [
      att({ name: "pic", contentType: "image/png" }),
      att({ name: "voice", contentType: "audio/ogg; codecs=opus" }),
      att({ name: "two" }),
    ];
    expect(pickAudioAttachment(list)?.name).toBe("voice");
    expect(pickAudioAttachment([att({ contentType: "application/pdf" })])).toBeNull();
    expect(pickAudioAttachment([att({ contentType: null })])).toBeNull();
    expect(pickAudioAttachment([])).toBeNull();
  });

  it("refuses an oversized attachment before downloading anything", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response("x");
    }) as unknown as typeof fetch;
    expect(await downloadAudio(att({ size: 101 }), config, fetcher)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(called).toBe(false);
  });

  it("stops downloading when the body is bigger than it claimed", async () => {
    const big = (async () => new Response(new Uint8Array(500))) as unknown as typeof fetch;
    expect(await downloadAudio(att({ size: 50 }), config, big)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("returns the audio in memory, and reports a failed download without throwing", async () => {
    const ok = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    const result = await downloadAudio(att({ size: 3 }), config, ok);
    expect(result.ok && Array.from(result.audio)).toEqual([1, 2, 3]);
    const bad = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await downloadAudio(att({ size: 3 }), config, bad)).toEqual({
      ok: false,
      reason: "failed",
    });
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await downloadAudio(att({ size: 3 }), config, boom)).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("reads a plain confirmation, and nothing that merely contains one", () => {
    expect(isAffirmative("yes")).toBe(true);
    expect(isAffirmative("Yeah that's it")).toBe(true);
    expect(isAffirmative("no, I said chem")).toBe(false);
    expect(isAffirmative("add yes man to my list")).toBe(false);
  });
});
