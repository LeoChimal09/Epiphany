import { z } from "zod";
import { ConfigError, type Env } from "../config";

// Voice settings, read from the environment. Everything has a default except the provider keys,
// which are optional: without a key the matching feature says it is not set up and text keeps working.
export interface VoiceConfig {
  transcription: {
    enabled: boolean;
    apiKey: string | null;
    model: string;
    pricePerMinuteUsd: number;
  };
  speech: {
    elevenLabsKey: string | null;
    elevenLabsVoiceId: string | null;
    elevenLabsPricePer1kChars: number;
    openAiKey: string | null;
    openAiModel: string;
    openAiVoice: string;
    openAiPricePer1kChars: number;
  };
  limits: { maxBytes: number; maxSeconds: number };
  budget: { monthlyLimitUsd: number; warnPercent: number };
  // Raw audio is never kept. Transcripts are only kept when the owner turns that on.
  keepTranscripts: boolean;
}

const positive = (hint: string) =>
  z.coerce.number({ error: `must be a number ${hint}` }).positive(`must be a number ${hint}`);

const schema = z.object({
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().trim().min(1).optional(),
  ELEVENLABS_VOICE_ID: z.string().trim().min(1).optional(),
  VOICE_TRANSCRIPTION_MODEL: z.string().trim().min(1).default("whisper-1"),
  VOICE_TRANSCRIPTION_USD_PER_MINUTE: positive("above zero").default(0.006),
  VOICE_TTS_OPENAI_MODEL: z.string().trim().min(1).default("tts-1"),
  VOICE_TTS_OPENAI_VOICE: z.string().trim().min(1).default("alloy"),
  VOICE_TTS_OPENAI_USD_PER_1K_CHARS: positive("above zero").default(0.015),
  VOICE_TTS_ELEVENLABS_USD_PER_1K_CHARS: positive("above zero").default(0.3),
  VOICE_MONTHLY_BUDGET_USD: positive("above zero").default(5),
  VOICE_BUDGET_WARN_PERCENT: positive("between 1 and 100").pipe(z.number().max(100)).default(80),
  AUDIO_MAX_BYTES: positive("above zero")
    .pipe(z.number().int())
    .default(8 * 1024 * 1024),
  AUDIO_MAX_SECONDS: positive("above zero").pipe(z.number().int()).default(300),
  VOICE_KEEP_TRANSCRIPTS: z.enum(["true", "false"]).default("false"),
});

export function loadVoiceConfig(env: Env): VoiceConfig {
  const result = schema.safeParse({
    OPENAI_API_KEY: env.OPENAI_API_KEY?.trim() || undefined,
    ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY?.trim() || undefined,
    ELEVENLABS_VOICE_ID: env.ELEVENLABS_VOICE_ID?.trim() || undefined,
    VOICE_TRANSCRIPTION_MODEL: env.VOICE_TRANSCRIPTION_MODEL?.trim() || undefined,
    VOICE_TRANSCRIPTION_USD_PER_MINUTE: env.VOICE_TRANSCRIPTION_USD_PER_MINUTE?.trim() || undefined,
    VOICE_TTS_OPENAI_MODEL: env.VOICE_TTS_OPENAI_MODEL?.trim() || undefined,
    VOICE_TTS_OPENAI_VOICE: env.VOICE_TTS_OPENAI_VOICE?.trim() || undefined,
    VOICE_TTS_OPENAI_USD_PER_1K_CHARS: env.VOICE_TTS_OPENAI_USD_PER_1K_CHARS?.trim() || undefined,
    VOICE_TTS_ELEVENLABS_USD_PER_1K_CHARS:
      env.VOICE_TTS_ELEVENLABS_USD_PER_1K_CHARS?.trim() || undefined,
    VOICE_MONTHLY_BUDGET_USD: env.VOICE_MONTHLY_BUDGET_USD?.trim() || undefined,
    VOICE_BUDGET_WARN_PERCENT: env.VOICE_BUDGET_WARN_PERCENT?.trim() || undefined,
    AUDIO_MAX_BYTES: env.AUDIO_MAX_BYTES?.trim() || undefined,
    AUDIO_MAX_SECONDS: env.AUDIO_MAX_SECONDS?.trim() || undefined,
    VOICE_KEEP_TRANSCRIPTS: env.VOICE_KEEP_TRANSCRIPTS?.trim() || undefined,
  });
  if (!result.success) {
    throw new ConfigError(
      "voice",
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const v = result.data;
  return {
    transcription: {
      enabled: v.OPENAI_API_KEY !== undefined,
      apiKey: v.OPENAI_API_KEY ?? null,
      model: v.VOICE_TRANSCRIPTION_MODEL,
      pricePerMinuteUsd: v.VOICE_TRANSCRIPTION_USD_PER_MINUTE,
    },
    speech: {
      elevenLabsKey: v.ELEVENLABS_API_KEY ?? null,
      elevenLabsVoiceId: v.ELEVENLABS_VOICE_ID ?? null,
      elevenLabsPricePer1kChars: v.VOICE_TTS_ELEVENLABS_USD_PER_1K_CHARS,
      openAiKey: v.OPENAI_API_KEY ?? null,
      openAiModel: v.VOICE_TTS_OPENAI_MODEL,
      openAiVoice: v.VOICE_TTS_OPENAI_VOICE,
      openAiPricePer1kChars: v.VOICE_TTS_OPENAI_USD_PER_1K_CHARS,
    },
    limits: { maxBytes: v.AUDIO_MAX_BYTES, maxSeconds: v.AUDIO_MAX_SECONDS },
    budget: {
      monthlyLimitUsd: v.VOICE_MONTHLY_BUDGET_USD,
      warnPercent: v.VOICE_BUDGET_WARN_PERCENT,
    },
    keepTranscripts: v.VOICE_KEEP_TRANSCRIPTS === "true",
  };
}
