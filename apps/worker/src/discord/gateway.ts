import {
  ChannelType,
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Message,
} from "discord.js";
import { ConfigError, loadAiConfig, type AiConfig, type Env } from "@epiphany/core";
import {
  createAssistant,
  createBudget,
  createDbUsageStore,
  createOpenAiProvider,
  emptyConversation,
  type ConversationState,
} from "@epiphany/core/assistant";
import { connectDatabase } from "@epiphany/core/db";
import { createServices, resolveDiscordPrincipal } from "@epiphany/core/services";
import { loadDiscordBotConfig } from "./config";
import { createDiscordWorkspaceCapability, prepareServer } from "./guild-adapter";
import { createOverviewSync } from "./overview-discord";
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
import { createVoiceManager, type VoiceManager } from "./voice-channel";
import {
  TRANSCRIPT_CONFIRM_MS,
  downloadAudio,
  isAffirmative,
  pickAudioAttachment,
  type PendingTranscript,
} from "./voice-discord";
import { createReminderRunner } from "./reminders-discord";
import {
  fitDiscordMessage,
  routeMessage,
  SHARED_CHANNEL_REPLY,
  splitDiscordMessage,
  stripEpiMention,
  type MessageFacts,
} from "./routing";

export interface DiscordGatewayOptions {
  databaseUrl: string;
  timezone: string;
  env: Env;
  clock?: () => Date;
}

export interface DiscordGateway {
  client: Client;
  stop: () => Promise<void>;
}

// How often the overviews are compared with the records, to catch changes made in the dashboard.
const OVERVIEW_POLL_MS = 15_000;
const REMINDER_POLL_MS = 15_000;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "discord", event, ...fields }),
  );
}

// Facts about where a message was sent. Channel visibility is read from Discord's own permission
// data (can @everyone see it?), never from the channel's name alone.
function factsAbout(message: Message, ownerUserId: string, epiUserId: string): MessageFacts {
  const channel = message.channel;
  const isDm = channel.isDMBased();
  const textChannel = !isDm && channel.type === ChannelType.GuildText ? channel : null;
  const everyoneCanView = textChannel
    ? textChannel
        .permissionsFor(textChannel.guild.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel)
    : undefined;
  return {
    authorIsBot: message.author.bot,
    authorId: message.author.id,
    ownerId: ownerUserId,
    isDm,
    channelName: textChannel?.name ?? null,
    parentName: textChannel?.parent?.name ?? null,
    ...(everyoneCanView === undefined ? {} : { everyoneCanView }),
    mentionsEpi: message.mentions.users.has(epiUserId),
  };
}

export async function startDiscordGateway(
  options: DiscordGatewayOptions,
): Promise<DiscordGateway | null> {
  const bot = loadDiscordBotConfig(options.env);
  if (!bot) return null;
  const ownerUserId = bot.ownerUserId;

  let aiConfig: AiConfig | null;
  try {
    aiConfig = loadAiConfig(options.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(JSON.stringify({ service: "discord", event: "ai_misconfigured" }));
      aiConfig = null;
    } else {
      throw error;
    }
  }

  // Voice is optional: without its keys, audio is declined politely and text works as usual.
  let voice: VoiceConfig | null = null;
  try {
    voice = loadVoiceConfig(options.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(JSON.stringify({ service: "discord", event: "voice_misconfigured" }));
  }
  const pendingTranscripts = new Map<string, PendingTranscript>();

  const database = connectDatabase(options.databaseUrl, 3);
  const clock = options.clock ?? (() => new Date());
  const conversations = new Map<string, ConversationState>();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      // Needed to see which voice channel the owner is in when they ask Epi to join.
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
  });

  const workspace = createDiscordWorkspaceCapability(client, ownerUserId);
  // Live voice conversation: only when transcription is configured.
  let voiceManager: VoiceManager | null = null;
  if (voice?.transcription.enabled && aiConfig?.enabled && aiConfig.apiKey) {
    const voiceConfig = voice;
    // The voice budget is recorded against the owner's record, which is looked up on first use. If
    // the owner is not linked yet, spending reads as exhausted, so nothing is called unbudgeted.
    const ownerRecordId = async () =>
      (
        await resolveDiscordPrincipal(database.db, ownerUserId, {
          audience: "private",
          initiator: "assistant",
        })
      )?.ownerId ?? null;
    const lazyVoiceStore = {
      async spent(period: string) {
        const id = await ownerRecordId();
        return id
          ? createProviderUsageStore(database.db, id, "voice").spent(period)
          : Number.POSITIVE_INFINITY;
      },
      async add(period: string, costUsd: number) {
        const id = await ownerRecordId();
        if (id) await createProviderUsageStore(database.db, id, "voice").add(period, costUsd);
      },
    };
    const makeBudget = () =>
      createBudget({ ...voiceConfig.budget, timezone: options.timezone }, lazyVoiceStore, clock);
    voiceManager = createVoiceManager({
      client,
      ownerUserId,
      config: voiceConfig,
      transcriber: createOpenAiTranscriber(voiceConfig.transcription),
      speakers: [
        createElevenLabsSpeech(voiceConfig.speech),
        createOpenAiSpeech(voiceConfig.speech),
      ],
      budget: makeBudget,
      repliesEnabled: async () => {
        const principal = await resolveDiscordPrincipal(database.db, ownerUserId, {
          audience: "private",
          initiator: "assistant",
        });
        if (!principal) return false;
        const pref = await createServices(database.db, { clock }).preferences.get(
          principal,
          "voice.replies",
        );
        return pref?.value === true;
      },
      respond: async (text, guildId) => {
        const principal = await resolveDiscordPrincipal(database.db, ownerUserId, {
          audience: "private",
          initiator: "assistant",
          source: "voice",
        });
        if (!principal || !aiConfig?.apiKey) return null;
        const key = `voice:${guildId}`;
        const assistant = createAssistant({
          appUrl: options.env.APP_URL || undefined,
          services: createServices(database.db, { clock }),
          provider: createOpenAiProvider({
            apiKey: aiConfig.apiKey,
            model: aiConfig.model,
            pricing: aiConfig.pricing,
            maxInputTokens: aiConfig.maxInputTokens,
            maxOutputTokens: aiConfig.maxOutputTokens,
            ...(aiConfig.baseUrl ? { baseUrl: aiConfig.baseUrl } : {}),
          }),
          budget: createBudget(
            {
              monthlyLimitUsd: aiConfig.monthlyBudgetUsd,
              warnPercent: aiConfig.warnPercent,
              timezone: aiConfig.timezone,
            },
            createDbUsageStore(database.db, principal.ownerId),
            clock,
          ),
          timezone: options.timezone,
          clock,
        });
        const result = await assistant.handle(
          principal,
          text,
          conversations.get(key) ?? emptyConversation(),
          { sourceRef: `voice:${guildId}` },
        );
        conversations.set(key, result.state);
        if (result.reply.changed) void overviews.run();
        return result.reply.text;
      },
    });
  }

  // Persistent reminders: independent of the model, safe to restart, delivered in private #check-ins.
  const reminderRunner = createReminderRunner({
    client,
    db: database.db,
    ownerUserId,
    timezone: options.timezone,
    clock,
    // Replies to a reminder ("done", "snooze", "not going") are understood in its context: the
    // The private-channel conversation remembers which reminder and which task or event it was about.
    onDelivered: (delivered, { channelId }) => {
      const reminder = delivered.at(-1);
      if (!channelId || !reminder || delivered.length !== 1) return;
      const title = /"([^"]{1,200})"/.exec(reminder.message)?.[1] ?? "that reminder";
      const state = conversations.get(channelId) ?? emptyConversation();
      const subjectType =
        reminder.subjectType === "task" || reminder.subjectType === "event"
          ? reminder.subjectType
          : null;
      conversations.set(channelId, {
        ...state,
        lastReminder: {
          reminderId: reminder.id,
          kind: reminder.kind,
          subjectType,
          subjectId: reminder.subjectId,
          title,
        },
        listed:
          subjectType === "task" && reminder.subjectId
            ? [{ id: reminder.subjectId, title, due: null }]
            : state.listed,
      });
    },
  });
  // Keeps the overview channels in step with the records, whichever side changed them.
  const overviews = createOverviewSync({
    client,
    db: database.db,
    ownerUserId,
    timezone: options.timezone,
    clock,
  });

  client.on("messageCreate", (message) => {
    void handleMessage(message).catch((error: unknown) => {
      log("message_failed", { error: error instanceof Error ? error.name : "unknown" });
      void message.reply("I couldn't process that just now. Nothing was changed.").catch(() => {
        log("reply_failed");
      });
    });
  });

  // Both events say, in the worker's logs, that Epi is actually connected and which servers it is
  // in. A server the owner owns is set up right away (adding Epi there is the approval); any other
  // server the owner is in gets a one-time offer DM. Both are safe to repeat at every start.
  client.once("clientReady", (ready) => {
    log("discord_ready", { guilds: ready.guilds.cache.size });
    void (async () => {
      for (const guild of ready.guilds.cache.values())
        await prepareServer(client, guild, ownerUserId);
      await overviews.run({ verify: true });
      overviews.start(OVERVIEW_POLL_MS);
      await reminderRunner.run();
      reminderRunner.start(REMINDER_POLL_MS);
    })().catch((error: unknown) => {
      log("discord_ready_setup_failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  });
  // Someone deleting an overview message only removes the message; it is put back, and no record is
  // touched.
  client.on("messageDelete", (message) => {
    if (message.author?.id === client.user?.id || message.author === null) {
      void overviews.run({ verify: true });
    }
  });
  client.on("guildCreate", (guild) => {
    log("discord_joined_server", { guildId: guild.id });
    void prepareServer(client, guild, ownerUserId);
  });

  await client.login(bot.token);

  return {
    client,
    async stop() {
      await voiceManager?.stop();
      overviews.stop();
      reminderRunner.stop();
      client.destroy();
      conversations.clear();
      await database.close();
    },
  };

  async function handleMessage(message: Message): Promise<void> {
    const epiUserId = client.user?.id;
    if (!epiUserId) return;
    const route = routeMessage(factsAbout(message, ownerUserId, epiUserId));
    if (route.action === "ignore") return;

    // Somewhere other people can read: say where to go, with no model call and no personal data.
    if (route.audience === "shared") {
      await message.reply(SHARED_CHANNEL_REPLY);
      return;
    }

    let text = stripEpiMention(message.content, epiUserId);
    const audioAttachment = pickAudioAttachment(message.attachments.values());
    if (!text && !audioAttachment) return;
    if (!aiConfig?.enabled || !aiConfig.apiKey) {
      await message.reply("Epi is connected, but its OpenAI key is not configured yet.");
      return;
    }

    const principal = await resolveDiscordPrincipal(database.db, ownerUserId, {
      audience: route.audience,
      initiator: "assistant",
    });
    if (!principal) {
      await message.reply(
        "I don't have your account linked yet. Sign in to the Epiphany dashboard once with Discord, then message me again.",
      );
      return;
    }

    // A voice message or audio file becomes text first, and then takes exactly the same path as
    // typed text. The raw audio is only held in memory for the transcription and is never stored.
    const waiting = pendingTranscripts.get(message.channelId);
    pendingTranscripts.delete(message.channelId);
    if (
      waiting &&
      waiting.expiresAt > clock().getTime() &&
      !audioAttachment &&
      isAffirmative(text)
    ) {
      text = waiting.text;
    } else if (audioAttachment) {
      if (!voice) {
        await message.reply(
          "Audio isn't set up yet, so please type it instead. Text works as usual.",
        );
        return;
      }
      const downloaded = await downloadAudio(audioAttachment, voice);
      if (!downloaded.ok) {
        await message.reply(
          downloaded.reason === "too_large"
            ? intakeMessage({ status: "rejected", reason: "too_large" }, voice)!
            : "I couldn't download that audio just now, so nothing was changed. Please try again, or type it.",
        );
        return;
      }
      const heard = await transcribeAudio({
        audio: downloaded.audio,
        mime: audioAttachment.contentType ?? "audio/ogg",
        filename: audioAttachment.name,
        durationSeconds: audioAttachment.duration ?? null,
        config: voice,
        provider: voice.transcription.enabled ? createOpenAiTranscriber(voice.transcription) : null,
        budget: createBudget(
          { ...voice.budget, timezone: options.timezone },
          createProviderUsageStore(database.db, principal.ownerId, "voice"),
          clock,
        ),
      });
      if (heard.status !== "ok") {
        if (heard.status === "uncertain") {
          pendingTranscripts.set(message.channelId, {
            text: heard.text,
            expiresAt: clock().getTime() + TRANSCRIPT_CONFIRM_MS,
          });
        }
        await message.reply(intakeMessage(heard, voice) ?? "I couldn't use that audio.");
        return;
      }
      text = heard.text;
      log("audio_transcribed", { characters: text.length });
    }
    if (!text) return;

    const state = conversations.get(message.channelId) ?? emptyConversation();
    const budget = createBudget(
      {
        monthlyLimitUsd: aiConfig.monthlyBudgetUsd,
        warnPercent: aiConfig.warnPercent,
        timezone: aiConfig.timezone,
      },
      createDbUsageStore(database.db, principal.ownerId),
      clock,
    );
    const assistant = createAssistant({
      appUrl: options.env.APP_URL || undefined,
      services: createServices(database.db, { clock }),
      provider: createOpenAiProvider({
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        pricing: aiConfig.pricing,
        maxInputTokens: aiConfig.maxInputTokens,
        maxOutputTokens: aiConfig.maxOutputTokens,
        ...(aiConfig.baseUrl ? { baseUrl: aiConfig.baseUrl } : {}),
      }),
      budget,
      timezone: options.timezone,
      workspace,
      ...(voiceManager
        ? { voice: { control: (_principal, action) => voiceManager!.control(message, action) } }
        : {}),
      clock,
    });

    const result = await assistant.handle(principal, text, state, {
      sourceRef: `discord:${message.channelId}/${message.id}`,
    });
    conversations.set(message.channelId, result.state);

    let reply = result.reply.text;
    // Setup from a server channel: also prove a direct message reaches the owner, and say so if
    // it does not (DMs from server members can be switched off).
    if (result.reply.outcome === "created" && !message.channel.isDMBased()) {
      reply += await directMessageCheck(message);
    }
    const replies =
      result.state.pendingCapture ||
      state.pendingCapture ||
      result.state.activeIdea ||
      state.activeIdea
        ? splitDiscordMessage(reply)
        : [fitDiscordMessage(reply)];
    for (const content of replies) {
      await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
    }
    await speakIfEnabled(message, principal, result.reply.text);
    // A change made here shows up in the overview channels straight away.
    if (result.reply.changed) void overviews.run();
  }

  // With spoken replies switched on (the owner's own setting), the reply also arrives as audio. The
  // text is always sent first, and any problem or spending limit simply leaves the text as it is.
  async function speakIfEnabled(
    message: Message,
    principal: Awaited<ReturnType<typeof resolveDiscordPrincipal>>,
    text: string,
  ): Promise<void> {
    if (!voice || !principal) return;
    try {
      const enabled =
        (await createServices(database.db, { clock }).preferences.get(principal, "voice.replies"))
          ?.value === true;
      const spoken = await speakReply({
        text,
        enabled,
        providers: [createElevenLabsSpeech(voice.speech), createOpenAiSpeech(voice.speech)],
        budget: createBudget(
          { ...voice.budget, timezone: options.timezone },
          createProviderUsageStore(database.db, principal.ownerId, "voice"),
          clock,
        ),
      });
      if (spoken.status !== "audio") return;
      await message.reply({
        files: [{ attachment: Buffer.from(spoken.audio), name: "epi-reply.mp3" }],
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch {
      log("spoken_reply_failed");
    }
  }

  async function directMessageCheck(message: Message): Promise<string> {
    try {
      await message.author.send(
        "Hi, it's Epi. This is a quick check that I can reach you here. You can message me in this DM any time.",
      );
      return "\nI also sent you a DM to confirm I can reach you there.";
    } catch (error) {
      const blocked = error instanceof DiscordAPIError && error.code === 50007;
      log("dm_check_failed", { blocked });
      return blocked
        ? "\nI couldn't DM you, so your direct messages from this server are probably turned off. I'll keep using #assistant, and you can allow DMs from server members if you'd like them."
        : "\nI couldn't send you a DM just now, so I'll keep using #assistant.";
    }
  }
}
