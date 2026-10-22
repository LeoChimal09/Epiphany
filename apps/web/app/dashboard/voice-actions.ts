"use server";

import {
  speakForDashboard,
  transcribeDashboardAudio,
  type HeardResult,
  type SpokenResult,
} from "./voice-server";

// Largest recording the dashboard will send (the server enforces its own, stricter limits too).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function transcribeMicrophone(form: FormData): Promise<HeardResult> {
  const file = form.get("audio");
  if (!(file instanceof Blob) || file.size === 0) {
    return { ok: false, error: "I didn't get any audio. Please try again." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "That recording is too big. Try a shorter one." };
  }
  const seconds = Number(form.get("seconds"));
  return transcribeDashboardAudio(
    new Uint8Array(await file.arrayBuffer()),
    file.type || "audio/webm",
    Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  );
}

export async function speakReplyAloud(text: unknown): Promise<SpokenResult> {
  if (typeof text !== "string" || !text.trim() || text.length > 4000) return { ok: false };
  return speakForDashboard(text);
}
