import { describe, expect, it, vi } from "vitest";
import { createBudget, createMemoryUsageStore } from "../assistant/budget";
import { loadVoiceConfig } from "./config";
import { intakeMessage, isSupportedAudio, transcribeAudio } from "./intake";
import {
  VoiceProviderError,
  createElevenLabsSpeech,
  createOpenAiSpeech,
  createOpenAiTranscriber,
  type SpeechProvider,
  type TranscriptionProvider,
} from "./providers";
import { MAX_SPOKEN_CHARS, speakReply, spokenText } from "./speak";

const KEY = "sk-test-secret-key";
const config = loadVoiceConfig({
  OPENAI_API_KEY: KEY,
  ELEVENLABS_API_KEY: "el-key",
  ELEVENLABS_VOICE_ID: "voice1",
});
const budget = (limit = 5) =>
  createBudget(
    { monthlyLimitUsd: limit, warnPercent: 80, timezone: "America/Chicago" },
    createMemoryUsageStore(),
    () => new Date("2026-10-14T15:00:00Z"),
  );
const audio = new Uint8Array([1, 2, 3, 4]);

const heard = (
  text: string,
  over: Partial<{ durationSeconds: number | null; confidence: number | null }> = {},
): TranscriptionProvider => ({
  transcribe: vi.fn(async () => ({ text, durationSeconds: 30, confidence: 0.9, ...over })),
});

describe("voice configuration", () => {
  it("has safe defaults, works without keys, and rejects bad values without echoing them", () => {
    const bare = loadVoiceConfig({});
    expect(bare.transcription.enabled).toBe(false);
    expect(bare.speech.elevenLabsKey).toBeNull();
    expect(bare.limits).toEqual({ maxBytes: 8 * 1024 * 1024, maxSeconds: 300 });
    expect(bare.keepTranscripts).toBe(false);
    expect(() => loadVoiceConfig({ VOICE_MONTHLY_BUDGET_USD: "free" })).toThrow(
      /VOICE_MONTHLY_BUDGET_USD/,
    );
  });
});

describe("audio intake", () => {
  it("turns clear speech into text for the same path as a typed message, and records the cost", async () => {
    const b = budget();
    const provider = heard("add a task to read chapter four by Friday");
    const result = await transcribeAudio({
      audio,
      mime: "audio/ogg",
      filename: "voice.ogg",
      durationSeconds: 30,
      config,
      provider,
      budget: b,
    });
    expect(result).toEqual({ status: "ok", text: "add a task to read chapter four by Friday" });
    expect((await b.check()).spentUsd).toBeCloseTo(0.003, 6);
  });

  it("asks the owner to confirm when it is not sure what was said", async () => {
    const result = await transcribeAudio({
      audio,
      mime: "audio/mpeg",
      filename: "a.mp3",
      config,
      provider: heard("tase the chem", { confidence: 0.2 }),
      budget: budget(),
    });
    expect(result).toEqual({ status: "uncertain", text: "tase the chem" });
    expect(intakeMessage(result, config)).toContain("Is that correct?");
  });

  it("refuses unsupported, oversized, too long, and empty input clearly, without calling the provider", async () => {
    const provider = heard("x");
    const run = (over: Record<string, unknown>) =>
      transcribeAudio({
        audio,
        mime: "audio/ogg",
        filename: "a.ogg",
        config,
        provider,
        budget: budget(),
        ...over,
      } as never);
    expect(await run({ mime: "application/pdf" })).toEqual({
      status: "rejected",
      reason: "unsupported_type",
    });
    expect(await run({ audio: new Uint8Array(config.limits.maxBytes + 1) })).toEqual({
      status: "rejected",
      reason: "too_large",
    });
    expect(await run({ durationSeconds: config.limits.maxSeconds + 1 })).toEqual({
      status: "rejected",
      reason: "too_long",
    });
    expect(await run({ audio: new Uint8Array(0) })).toEqual({
      status: "rejected",
      reason: "empty",
    });
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(intakeMessage({ status: "rejected", reason: "too_large" }, config)).toContain("8 MB");
    expect(intakeMessage({ status: "rejected", reason: "too_long" }, config)).toContain(
      "5 minutes",
    );
    expect(isSupportedAudio("audio/ogg; codecs=opus")).toBe(true);
  });

  it("stops at the voice budget and when transcription is not set up or the provider fails", async () => {
    const full = budget(0.001);
    await full.record(0.01);
    const provider = heard("hello");
    const limited = await transcribeAudio({
      audio,
      mime: "audio/ogg",
      filename: "a.ogg",
      config,
      provider,
      budget: full,
    });
    expect(limited).toEqual({ status: "unavailable", reason: "budget" });
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(intakeMessage(limited, config)).toContain("resets on the 1st");

    const off = loadVoiceConfig({});
    expect(
      await transcribeAudio({
        audio,
        mime: "audio/ogg",
        filename: "a.ogg",
        config: off,
        provider: null,
        budget: budget(),
      }),
    ).toEqual({ status: "unavailable", reason: "not_configured" });

    const broken: TranscriptionProvider = {
      transcribe: async () => {
        throw new VoiceProviderError("down", 500);
      },
    };
    const failed = await transcribeAudio({
      audio,
      mime: "audio/ogg",
      filename: "a.ogg",
      config,
      provider: broken,
      budget: budget(),
    });
    expect(failed).toEqual({ status: "unavailable", reason: "provider_error" });
    expect(intakeMessage(failed, config)).toContain("nothing was changed");
  });
});

describe("spoken replies", () => {
  const speaker = (
    name: SpeechProvider["name"],
    impl?: () => Promise<{ audio: Uint8Array; mime: string }>,
  ): SpeechProvider & { calls: number } => {
    const s = {
      name,
      pricePer1kChars: 0.3,
      calls: 0,
      synthesize: async () => {
        s.calls++;
        return impl ? impl() : { audio: new Uint8Array([9]), mime: "audio/mpeg" };
      },
    };
    return s;
  };

  it("keeps text only when voice is off, and cleans and caps what it speaks", async () => {
    const off = await speakReply({
      text: "Hi",
      enabled: false,
      providers: [speaker("elevenlabs")],
      budget: budget(),
    });
    expect(off).toEqual({ status: "text_only", reason: "disabled" });
    expect(spokenText("**Done.** See https://x.test now\n• one\n• two")).toBe(
      "Done. See now. one. two",
    );
    expect(spokenText("A sentence. ".repeat(200)).length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
  });

  it("uses ElevenLabs first and bills the voice budget", async () => {
    const eleven = speaker("elevenlabs");
    const b = budget();
    const result = await speakReply({
      text: "Reminder: chem lab is due tomorrow.",
      enabled: true,
      providers: [eleven, speaker("openai")],
      budget: b,
    });
    expect(result).toMatchObject({ status: "audio", provider: "elevenlabs" });
    expect((await b.check()).spentUsd).toBeGreaterThan(0);
  });

  it("falls back to the other provider on failure, but never past the spending limit", async () => {
    const failing = speaker("elevenlabs", async () => {
      throw new VoiceProviderError("down", 500);
    });
    const fallback = speaker("openai");
    const ok = await speakReply({
      text: "Hello there",
      enabled: true,
      providers: [failing, fallback],
      budget: budget(),
    });
    expect(ok).toMatchObject({ status: "audio", provider: "openai" });

    const tiny = budget(0.00001);
    const eleven = speaker("elevenlabs");
    await speakReply({ text: "x".repeat(400), enabled: true, providers: [eleven], budget: tiny });
    const second = speaker("openai");
    const blocked = await speakReply({
      text: "Hello",
      enabled: true,
      providers: [
        speaker("elevenlabs", async () => {
          throw new VoiceProviderError("down");
        }),
        second,
      ],
      budget: tiny,
    });
    expect(blocked).toEqual({ status: "text_only", reason: "budget" });
    expect(second.calls).toBe(0);
  });

  it("falls back to text when every provider fails or none is configured", async () => {
    const failing = speaker("elevenlabs", async () => {
      throw new VoiceProviderError("down", 500);
    });
    expect(
      await speakReply({ text: "Hello", enabled: true, providers: [failing], budget: budget() }),
    ).toEqual({ status: "text_only", reason: "provider_error" });
    expect(
      await speakReply({ text: "Hello", enabled: true, providers: [null], budget: budget() }),
    ).toEqual({ status: "text_only", reason: "not_configured" });
  });
});

describe("provider adapters", () => {
  it("sends the transcription request without leaking the key on failure, and parses confidence", async () => {
    const okFetch = vi.fn(async () =>
      Response.json({
        text: " hello there ",
        duration: 12.5,
        segments: [{ avg_logprob: -0.1, no_speech_prob: 0.01 }],
      }),
    );
    const transcriber = createOpenAiTranscriber(
      config.transcription,
      okFetch as unknown as typeof fetch,
    );
    const transcript = await transcriber.transcribe({
      audio,
      filename: "a.ogg",
      mime: "audio/ogg",
    });
    expect(transcript.text).toBe("hello there");
    expect(transcript.durationSeconds).toBe(12.5);
    expect(transcript.confidence).toBeCloseTo(Math.exp(-0.1), 5);
    const [url, init] = okFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);

    const bad = createOpenAiTranscriber(
      config.transcription,
      (async () => new Response("secret body " + KEY, { status: 401 })) as unknown as typeof fetch,
    );
    const error = await bad
      .transcribe({ audio, filename: "a.ogg", mime: "audio/ogg" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect(String((error as Error).message)).not.toContain(KEY);
    expect(String((error as Error).message)).not.toContain("secret body");
  });

  it("only offers speech providers that are configured, and calls the right endpoints", async () => {
    expect(createElevenLabsSpeech(loadVoiceConfig({}).speech)).toBeNull();
    expect(createOpenAiSpeech(loadVoiceConfig({}).speech)).toBeNull();
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const eleven = createElevenLabsSpeech(config.speech, fake)!;
    const openai = createOpenAiSpeech(config.speech, fake)!;
    expect((await eleven.synthesize("hi")).mime).toBe("audio/mpeg");
    await openai.synthesize("hi");
    expect(calls[0]).toContain("api.elevenlabs.io/v1/text-to-speech/voice1");
    expect(calls[1]).toBe("https://api.openai.com/v1/audio/speech");
  });
});
