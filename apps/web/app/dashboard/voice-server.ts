import "server-only";
import { createBudget, type Budget } from "@epiphany/core/assistant";
import { ConfigError } from "@epiphany/core";
import {
  createElevenLabsSpeech,
  createOpenAiSpeech,
  createOpenAiTranscriber,
  createProviderUsageStore,
  intakeMessage,
  loadVoiceConfig,
  speakReply,
  transcribeAudio,
  type VoiceConfig,
} from "@epiphany/core/voice";
import { getAuthDeps } from "../../lib/auth/deps";
import { dashboardContext } from "./server-data";

export type { VoiceStatus } from "./voice-status";
import type { VoiceStatus } from "./voice-status";

function readConfig(): VoiceConfig | null {
  try {
    return loadVoiceConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    return null;
  }
}

function budgetFor(config: VoiceConfig, ownerId: string): Budget | null {
  const deps = getAuthDeps();
  if (!deps) return null;
  return createBudget(
    { ...config.budget, timezone: deps.config.timezone },
    createProviderUsageStore(deps.db, ownerId, "voice"),
    deps.clock,
  );
}

export async function voiceStatus(): Promise<VoiceStatus> {
  const config = readConfig();
  if (!config) return { listen: false, speak: false };
  const { principal, services } = await dashboardContext();
  const wantsSpeech = (await services.preferences.get(principal, "voice.replies"))?.value === true;
  const hasSpeech = Boolean(config.speech.elevenLabsKey || config.speech.openAiKey);
  return { listen: config.transcription.enabled, speak: wantsSpeech && hasSpeech };
}

export type HeardResult =
  { ok: true; text: string; uncertain: boolean } | { ok: false; error: string };

// Turns a recording from the dashboard's microphone into text. Same limits, same budget, and same
// refusals as audio sent in Discord; the audio is held in memory only for this call.
export async function transcribeDashboardAudio(
  audio: Uint8Array,
  mime: string,
  durationSeconds: number | null,
): Promise<HeardResult> {
  const config = readConfig();
  if (!config) return { ok: false, error: "Audio isn't set up yet, so please type it instead." };
  const { principal } = await dashboardContext();
  const budget = budgetFor(config, principal.ownerId);
  if (!budget) return { ok: false, error: "The dashboard isn't configured for audio yet." };
  const result = await transcribeAudio({
    audio,
    mime,
    filename: "dashboard-recording",
    durationSeconds,
    config,
    provider: config.transcription.enabled ? createOpenAiTranscriber(config.transcription) : null,
    budget,
  });
  if (result.status === "ok") return { ok: true, text: result.text, uncertain: false };
  if (result.status === "uncertain") return { ok: true, text: result.text, uncertain: true };
  return { ok: false, error: intakeMessage(result, config) ?? "I couldn't use that audio." };
}

export type SpokenResult = { ok: true; audioBase64: string; mime: string } | { ok: false };

export async function speakForDashboard(text: string): Promise<SpokenResult> {
  const config = readConfig();
  if (!config) return { ok: false };
  const { principal, services } = await dashboardContext();
  const enabled = (await services.preferences.get(principal, "voice.replies"))?.value === true;
  const budget = budgetFor(config, principal.ownerId);
  if (!budget) return { ok: false };
  const spoken = await speakReply({
    text,
    enabled,
    providers: [createElevenLabsSpeech(config.speech), createOpenAiSpeech(config.speech)],
    budget,
  });
  if (spoken.status !== "audio") return { ok: false };
  return { ok: true, audioBase64: Buffer.from(spoken.audio).toString("base64"), mime: spoken.mime };
}
