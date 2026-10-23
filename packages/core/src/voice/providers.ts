import type { VoiceConfig } from "./config";

export class VoiceProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "VoiceProviderError";
    this.status = status;
  }
}

export interface Transcript {
  text: string;
  durationSeconds: number | null;
  // 0 to 1 when the provider reports how sure it is; null when it does not.
  confidence: number | null;
}

export interface TranscriptionProvider {
  transcribe(input: { audio: Uint8Array; filename: string; mime: string }): Promise<Transcript>;
}

export interface SpeechResult {
  audio: Uint8Array;
  mime: string;
}

// mp3 for attachments; ogg opus for playing in a voice channel without needing ffmpeg.
export type AudioFormat = "mp3" | "opus";

export interface SpeechProvider {
  name: "elevenlabs" | "openai";
  pricePer1kChars: number;
  synthesize(text: string, format?: AudioFormat): Promise<SpeechResult>;
}

type Fetch = typeof fetch;

async function failure(response: Response, what: string): Promise<VoiceProviderError> {
  // Never include the response body or request details: they can echo keys or the owner's words.
  return new VoiceProviderError(`${what} failed with HTTP ${response.status}.`, response.status);
}

export function createOpenAiTranscriber(
  config: VoiceConfig["transcription"],
  doFetch: Fetch = fetch,
): TranscriptionProvider {
  return {
    async transcribe({ audio, filename, mime }) {
      if (!config.apiKey) throw new VoiceProviderError("Transcription is not configured.");
      const form = new FormData();
      form.append("file", new Blob([audio as BlobPart], { type: mime }), filename);
      form.append("model", config.model);
      form.append("response_format", "verbose_json");
      let response: Response;
      try {
        response = await doFetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new VoiceProviderError("The transcription service could not be reached.");
      }
      if (!response.ok) throw await failure(response, "Transcription");
      const body = (await response.json().catch(() => null)) as {
        text?: unknown;
        duration?: unknown;
        segments?: { avg_logprob?: unknown; no_speech_prob?: unknown }[];
      } | null;
      if (!body || typeof body.text !== "string") {
        throw new VoiceProviderError("The transcription service returned an unreadable answer.");
      }
      const logprobs = (body.segments ?? [])
        .map((segment) => segment.avg_logprob)
        .filter((value): value is number => typeof value === "number");
      const noSpeech = (body.segments ?? []).some(
        (segment) => typeof segment.no_speech_prob === "number" && segment.no_speech_prob > 0.8,
      );
      const confidence =
        logprobs.length > 0
          ? Math.exp(logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length)
          : null;
      return {
        text: noSpeech && body.text.trim().length < 4 ? "" : body.text.trim(),
        durationSeconds: typeof body.duration === "number" ? body.duration : null,
        confidence,
      };
    },
  };
}

export function createElevenLabsSpeech(
  config: VoiceConfig["speech"],
  doFetch: Fetch = fetch,
): SpeechProvider | null {
  if (!config.elevenLabsKey || !config.elevenLabsVoiceId) return null;
  const key = config.elevenLabsKey;
  const voice = encodeURIComponent(config.elevenLabsVoiceId);
  return {
    name: "elevenlabs",
    pricePer1kChars: config.elevenLabsPricePer1kChars,
    async synthesize(text, format = "mp3") {
      let response: Response;
      try {
        response = await doFetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=${format === "opus" ? "opus_48000_64" : "mp3_44100_128"}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": key,
              "content-type": "application/json",
              accept: format === "opus" ? "audio/ogg" : "audio/mpeg",
            },
            body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch {
        throw new VoiceProviderError("The speech service could not be reached.");
      }
      if (!response.ok) throw await failure(response, "Speech synthesis");
      return {
        audio: new Uint8Array(await response.arrayBuffer()),
        mime: format === "opus" ? "audio/ogg" : "audio/mpeg",
      };
    },
  };
}

export function createOpenAiSpeech(
  config: VoiceConfig["speech"],
  doFetch: Fetch = fetch,
): SpeechProvider | null {
  if (!config.openAiKey) return null;
  const key = config.openAiKey;
  return {
    name: "openai",
    pricePer1kChars: config.openAiPricePer1kChars,
    async synthesize(text, format = "mp3") {
      let response: Response;
      try {
        response = await doFetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: config.openAiModel,
            voice: config.openAiVoice,
            input: text,
            response_format: format,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new VoiceProviderError("The speech service could not be reached.");
      }
      if (!response.ok) throw await failure(response, "Speech synthesis");
      return {
        audio: new Uint8Array(await response.arrayBuffer()),
        mime: format === "opus" ? "audio/ogg" : "audio/mpeg",
      };
    },
  };
}
