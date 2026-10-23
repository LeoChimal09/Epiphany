import type { Budget } from "../assistant/budget";
import type { AudioFormat, SpeechProvider } from "./providers";
import { VoiceProviderError } from "./providers";

// A spoken reply is a short version of the text reply: long answers are cut at a sentence.
export const MAX_SPOKEN_CHARS = 900;

export type SpeakResult =
  | { status: "audio"; audio: Uint8Array; mime: string; provider: SpeechProvider["name"] }
  // The text reply is always sent; this says why there is no audio with it.
  | {
      status: "text_only";
      reason: "disabled" | "not_configured" | "budget" | "provider_error" | "empty";
    };

// Turns reply text into something worth saying aloud: formatting and links removed, capped.
export function spokenText(text: string): string {
  const plain = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`~>#|]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= MAX_SPOKEN_CHARS) return plain;
  const head = plain.slice(0, MAX_SPOKEN_CHARS);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return end > MAX_SPOKEN_CHARS / 2 ? head.slice(0, end + 1) : head.trimEnd();
}

// Speaks a reply if the owner turned voice on. Providers are tried in order (ElevenLabs, then the
// OpenAI fallback), but the voice budget is checked before every attempt, so falling back can never
// be a way around the spending limit; at the limit, or on any failure, the reply stays text only.
export async function speakReply(options: {
  text: string;
  enabled: boolean;
  providers: (SpeechProvider | null)[];
  budget: Budget;
  format?: AudioFormat;
}): Promise<SpeakResult> {
  if (!options.enabled) return { status: "text_only", reason: "disabled" };
  const providers = options.providers.filter((p): p is SpeechProvider => p !== null);
  if (providers.length === 0) return { status: "text_only", reason: "not_configured" };
  const spoken = spokenText(options.text);
  if (!spoken) return { status: "text_only", reason: "empty" };

  let failed = false;
  for (const provider of providers) {
    if (!(await options.budget.check()).allowed) return { status: "text_only", reason: "budget" };
    try {
      const result = await provider.synthesize(spoken, options.format);
      await options.budget.record((spoken.length / 1000) * provider.pricePer1kChars);
      return { status: "audio", audio: result.audio, mime: result.mime, provider: provider.name };
    } catch (error) {
      if (!(error instanceof VoiceProviderError)) throw error;
      failed = true;
    }
  }
  return { status: "text_only", reason: failed ? "provider_error" : "not_configured" };
}
