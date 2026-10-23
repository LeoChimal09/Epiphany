import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import type { Client, Message, VoiceBasedChannel } from "discord.js";
import type { VoiceAction, VoiceControlResult } from "@epiphany/core/assistant";
import {
  createVoiceSession,
  intakeMessage,
  speakReply,
  transcribeAudio,
  type SpeechProvider,
  type TranscriptionProvider,
  type VoiceConfig,
  type VoiceSession,
} from "@epiphany/core/voice";
import type { Budget } from "@epiphany/core/assistant";
import { PCM_CHANNELS, PCM_RATE, pcmSeconds, pcmToWav16kMono } from "./pcm";

const IDLE_MS = 5 * 60_000;
const SILENCE_MS = 1_200;
const MIN_SECONDS = 0.5;
const MAX_SECONDS = 60;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "discord", event, ...fields }),
  );
}

interface Live {
  session: VoiceSession;
  connection: VoiceConnection;
  player: AudioPlayer;
  guildId: string;
  channelName: string;
  listening: Set<string>;
  timer: ReturnType<typeof setInterval>;
  busy: boolean;
}

export interface VoiceManagerDeps {
  client: Client;
  ownerUserId: string;
  config: VoiceConfig;
  transcriber: TranscriptionProvider | null;
  speakers: (SpeechProvider | null)[];
  budget: () => Budget;
  // Runs a transcript through the assistant exactly like typed text and returns the reply text,
  // or null when nothing should be said.
  respond: (text: string, guildId: string) => Promise<string | null>;
  // Whether the owner switched on spoken replies.
  repliesEnabled: () => Promise<boolean>;
}

// Live voice conversation in a server voice channel. Epi joins only when the owner asks, says in
// text that it is listening, acts only on the owner's own audio, never records or keeps raw audio,
// and leaves on request or after five quiet minutes. The rules live in createVoiceSession; this
// connects them to Discord's voice gateway. Spoken answers are played aloud, so anyone in the
// channel hears them: the join announcement says so, and the written copy goes to the owner's DM.
export function createVoiceManager(deps: VoiceManagerDeps) {
  const live = new Map<string, Live>();

  async function dm(text: string): Promise<void> {
    try {
      const owner = await deps.client.users.fetch(deps.ownerUserId);
      await owner.send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } });
    } catch {
      log("voice_dm_failed");
    }
  }

  async function leave(guildId: string, reason: string): Promise<void> {
    const entry = live.get(guildId);
    if (!entry) return;
    clearInterval(entry.timer);
    entry.player.stop();
    entry.connection.destroy();
    live.delete(guildId);
    log("voice_left", { guildId, reason });
    if (reason === "idle") await dm("I left the voice channel because it was quiet for a while.");
  }

  async function speak(entry: Live, text: string): Promise<void> {
    if (entry.session.repliesMuted || !(await deps.repliesEnabled())) return;
    const spoken = await speakReply({
      text,
      enabled: true,
      providers: deps.speakers,
      budget: deps.budget(),
      format: "opus",
    });
    if (spoken.status !== "audio") return;
    const resource = createAudioResource(Readable.from([Buffer.from(spoken.audio)]), {
      inputType: StreamType.OggOpus,
    });
    entry.connection.subscribe(entry.player);
    entry.player.play(resource);
  }

  async function handleUtterance(entry: Live, speakerId: string, pcm: Buffer): Promise<void> {
    if (entry.busy) return;
    const seconds = pcmSeconds(pcm);
    if (seconds < MIN_SECONDS) return;
    entry.busy = true;
    try {
      const heard = await transcribeAudio({
        audio: pcmToWav16kMono(pcm),
        mime: "audio/wav",
        filename: "speech.wav",
        durationSeconds: seconds,
        config: deps.config,
        provider: deps.transcriber,
        budget: deps.budget(),
      });
      if (heard.status === "uncertain") {
        await dm(intakeMessage(heard, deps.config) ?? "I couldn't make that out.");
        return;
      }
      if (heard.status !== "ok") {
        const text = intakeMessage(heard, deps.config);
        if (text && heard.status === "unavailable") await dm(text);
        return;
      }
      const reply = await deps.respond(heard.text, entry.guildId);
      if (!reply) return;
      await dm(`You said: "${heard.text}"\n${reply}`);
      await speak(entry, reply);
    } finally {
      entry.busy = false;
    }
    log("voice_utterance", {
      guildId: entry.guildId,
      seconds: Math.round(seconds),
      speaker: speakerId === deps.ownerUserId ? "owner" : "other",
    });
  }

  function listen(entry: Live): void {
    entry.connection.receiver.speaking.on("start", (userId) => {
      // Only the owner's audio is ever captured: anyone else is never subscribed to.
      if (entry.session.hear(userId).action !== "act" || entry.listening.has(userId)) return;
      entry.listening.add(userId);
      const decoder = new OpusScript(PCM_RATE, PCM_CHANNELS, OpusScript.Application.AUDIO);
      const chunks: Buffer[] = [];
      let bytes = 0;
      const stream = entry.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
      });
      stream.on("data", (packet: Buffer) => {
        if (bytes / (PCM_RATE * PCM_CHANNELS * 2) > MAX_SECONDS) return;
        try {
          const pcm = decoder.decode(packet);
          chunks.push(pcm);
          bytes += pcm.length;
        } catch {
          // A corrupt packet is skipped; the rest of the utterance is still usable.
        }
      });
      stream.once("end", () => {
        entry.listening.delete(userId);
        decoder.delete();
        void handleUtterance(entry, userId, Buffer.concat(chunks)).catch(() =>
          log("voice_utterance_failed"),
        );
      });
    });
  }

  async function join(message: Message): Promise<VoiceControlResult> {
    const channel: VoiceBasedChannel | null | undefined = message.member?.voice.channel;
    if (!channel) return { status: "not_in_voice" };
    const guildId = channel.guild.id;
    if (live.has(guildId)) return { status: "nothing_to_do" };

    const session = createVoiceSession({ ownerUserId: deps.ownerUserId, idleTimeoutMs: IDLE_MS });
    const decision = session.join(message.author.id, channel.name);
    if (!decision.ok) return { status: "unavailable" };

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      log("voice_join_failed", { guildId });
      return { status: "unavailable" };
    }
    const player = createAudioPlayer();
    const entry: Live = {
      session,
      connection,
      player,
      guildId,
      channelName: channel.name,
      listening: new Set(),
      busy: false,
      timer: setInterval(() => {
        if (session.idleExpired()) void leave(guildId, "idle");
      }, 30_000),
    };
    entry.timer.unref();
    live.set(guildId, entry);
    connection.on(VoiceConnectionStatus.Disconnected, () => void leave(guildId, "disconnected"));
    listen(entry);
    log("voice_joined", { guildId });
    return { status: "ok", text: decision.announce };
  }

  return {
    // Handles a voice instruction from the owner's message.
    async control(message: Message, action: VoiceAction): Promise<VoiceControlResult> {
      if (action === "join") return join(message);
      const guildId = message.guildId;
      const entry = guildId ? live.get(guildId) : undefined;
      if (!entry) return { status: "nothing_to_do" };
      const who = message.author.id;
      switch (action) {
        case "leave":
          if (!entry.session.leave(who)) return { status: "nothing_to_do" };
          await leave(entry.guildId, "requested");
          return { status: "ok", text: "Okay, I've left the voice channel." };
        case "stop_listening":
          return entry.session.stopListening(who)
            ? {
                status: "ok",
                text: "Okay, I've stopped listening. I'm still in the channel; say the word and I'll start again.",
              }
            : { status: "nothing_to_do" };
        case "resume_listening":
          return entry.session.resumeListening(who)
            ? { status: "ok", text: "I'm listening again." }
            : { status: "nothing_to_do" };
        case "mute_replies":
          return entry.session.muteReplies(who, true)
            ? { status: "ok", text: "Okay, I'll keep my replies in text and stay quiet out loud." }
            : { status: "nothing_to_do" };
        case "unmute_replies":
          return entry.session.muteReplies(who, false)
            ? { status: "ok", text: "Okay, I'll speak my replies again." }
            : { status: "nothing_to_do" };
        default:
          return { status: "nothing_to_do" };
      }
    },
    async stop(): Promise<void> {
      for (const guildId of [...live.keys()]) await leave(guildId, "shutdown");
    },
    isPlaying: (guildId: string) =>
      live.get(guildId)?.player.state.status === AudioPlayerStatus.Playing,
  };
}

export type VoiceManager = ReturnType<typeof createVoiceManager>;
