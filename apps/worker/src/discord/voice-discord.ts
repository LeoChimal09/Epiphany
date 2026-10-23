import type { VoiceConfig } from "@epiphany/core/voice";
import { isSupportedAudio } from "@epiphany/core/voice";

export interface AttachmentLike {
  url: string;
  name: string;
  size: number;
  contentType: string | null;
  duration?: number | null;
}

// The first attachment that is audio (a Discord voice message, or an uploaded audio file). Other
// attachments (images, documents) are ignored: Epi does not read them.
export function pickAudioAttachment<T extends AttachmentLike>(attachments: Iterable<T>): T | null {
  for (const attachment of attachments) {
    const type = attachment.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (type.startsWith("audio/") || (type === "video/webm" && isSupportedAudio(type))) {
      return attachment;
    }
  }
  return null;
}

export type DownloadResult =
  { ok: true; audio: Uint8Array } | { ok: false; reason: "too_large" | "failed" };

// Downloads an attachment into memory, refusing anything over the size limit before and while
// downloading. The audio is never written to disk.
export async function downloadAudio(
  attachment: AttachmentLike,
  config: VoiceConfig,
  doFetch: typeof fetch = fetch,
): Promise<DownloadResult> {
  if (attachment.size > config.limits.maxBytes) return { ok: false, reason: "too_large" };
  try {
    const response = await doFetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) return { ok: false, reason: "failed" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > config.limits.maxBytes) return { ok: false, reason: "too_large" };
      chunks.push(chunk);
    }
    const audio = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, audio };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

// A transcript Epi was unsure of waits for the owner's confirmation. This is the one place a plain
// "yes" is read directly, because it answers a question Epi just asked about what it heard.
const AFFIRMATIVE =
  /^\s*(?:yes|yeah|yep|yup|correct|that'?s right|right|exactly|sure|ok(?:ay)?)\b/i;

export const isAffirmative = (text: string): boolean => AFFIRMATIVE.test(text);

export interface PendingTranscript {
  text: string;
  expiresAt: number;
}

export const TRANSCRIPT_CONFIRM_MS = 5 * 60_000;
