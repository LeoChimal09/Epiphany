import type { Budget } from "../assistant/budget";
import type { VoiceConfig } from "./config";
import type { TranscriptionProvider } from "./providers";
import { VoiceProviderError } from "./providers";

// Audio types Epi will transcribe. Anything else is refused clearly instead of guessed at.
const SUPPORTED = new Map<string, string>([
  ["audio/ogg", "ogg"],
  ["audio/opus", "ogg"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/aac", "m4a"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/webm", "webm"],
  ["video/webm", "webm"],
]);

export function isSupportedAudio(mime: string): boolean {
  return SUPPORTED.has(mime.split(";")[0]!.trim().toLowerCase());
}

export type IntakeResult =
  // Heard clearly: pass the text to the same path as a typed message.
  | { status: "ok"; text: string }
  // Heard, but not reliably enough to act on: ask the owner to confirm what was said.
  | { status: "uncertain"; text: string }
  | { status: "rejected"; reason: "unsupported_type" | "too_large" | "too_long" | "empty" }
  | { status: "unavailable"; reason: "not_configured" | "budget" | "provider_error" };

const MIN_CONFIDENCE = 0.45;
// A guess at length when the sender did not say: voice-message bitrates are around 16 KB a second.
const BYTES_PER_SECOND = 16_000;

// Turns an audio attachment into text, or says exactly why not. The raw audio is only held in
// memory for this call and is never stored. Cost is checked before the provider is called and
// recorded after, against the voice budget (a limit separate from the text budget).
export async function transcribeAudio(options: {
  audio: Uint8Array;
  mime: string;
  filename: string;
  durationSeconds?: number | null;
  config: VoiceConfig;
  provider: TranscriptionProvider | null;
  budget: Budget;
}): Promise<IntakeResult> {
  const { audio, config, budget } = options;
  if (!isSupportedAudio(options.mime)) return { status: "rejected", reason: "unsupported_type" };
  if (audio.byteLength === 0) return { status: "rejected", reason: "empty" };
  if (audio.byteLength > config.limits.maxBytes) return { status: "rejected", reason: "too_large" };
  if (options.durationSeconds && options.durationSeconds > config.limits.maxSeconds) {
    return { status: "rejected", reason: "too_long" };
  }
  if (!config.transcription.enabled || !options.provider) {
    return { status: "unavailable", reason: "not_configured" };
  }
  if (!(await budget.check()).allowed) return { status: "unavailable", reason: "budget" };

  try {
    const transcript = await options.provider.transcribe({
      audio,
      filename:
        options.filename ||
        `audio.${SUPPORTED.get(options.mime.split(";")[0]!.trim().toLowerCase())}`,
      mime: options.mime,
    });
    const seconds =
      transcript.durationSeconds ?? options.durationSeconds ?? audio.byteLength / BYTES_PER_SECOND;
    await budget.record((seconds / 60) * config.transcription.pricePerMinuteUsd);

    if (transcript.durationSeconds && transcript.durationSeconds > config.limits.maxSeconds) {
      return { status: "rejected", reason: "too_long" };
    }
    const text = transcript.text.trim();
    if (text.length < 2) return { status: "rejected", reason: "empty" };
    if (transcript.confidence !== null && transcript.confidence < MIN_CONFIDENCE) {
      return { status: "uncertain", text };
    }
    return { status: "ok", text };
  } catch (error) {
    if (!(error instanceof VoiceProviderError)) throw error;
    return { status: "unavailable", reason: "provider_error" };
  }
}

// What to tell the owner when audio could not be turned into an action.
export function intakeMessage(result: IntakeResult, config: VoiceConfig): string | null {
  switch (result.status) {
    case "ok":
      return null;
    case "uncertain":
      return `I'm not sure I heard that right. I think you said: "${result.text}". Is that correct? Say yes and I'll go ahead, or just type it.`;
    case "rejected":
      switch (result.reason) {
        case "unsupported_type":
          return "I can read voice messages and common audio files (mp3, m4a, ogg, wav, webm), but not that kind of file.";
        case "too_large":
          return `That audio file is too big for me (the limit is ${Math.round(config.limits.maxBytes / 1024 / 1024)} MB). Could you send a shorter clip?`;
        case "too_long":
          return `That recording is too long for me (the limit is ${Math.round(config.limits.maxSeconds / 60)} minutes). Could you send it in shorter pieces?`;
        case "empty":
          return "I couldn't make out any speech in that. Could you try again or type it?";
      }
    // falls through
    case "unavailable":
      switch (result.reason) {
        case "not_configured":
          return "Audio isn't set up yet, so please type it instead. Text works as usual.";
        case "budget":
          return "I've reached this month's voice limit, so I can't transcribe audio until it resets on the 1st. Text works as usual.";
        case "provider_error":
          return "I couldn't transcribe that just now, and nothing was changed. Please try again, or type it.";
      }
  }
}
