import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
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
import { createServices, issueOwnerPrincipal } from "@epiphany/core/services";
import { loadDiscordBotConfig } from "./config";

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

function isAssistantMessage(message: Message, ownerUserId: string): boolean {
  if (message.author.bot || message.author.id !== ownerUserId) return false;
  return (
    message.channel.isDMBased() ||
    ("name" in message.channel && message.channel.name === "assistant")
  );
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

  const database = connectDatabase(options.databaseUrl, 3);
  const clock = options.clock ?? (() => new Date());
  const conversations = new Map<string, ConversationState>();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on("messageCreate", (message) => {
    void handleMessage(message).catch(() => {
      void message.reply("I couldn't process that just now. Nothing was changed.");
    });
  });

  await client.login(bot.token);

  return {
    client,
    async stop() {
      client.destroy();
      conversations.clear();
      await database.close();
    },
  };

  async function handleMessage(message: Message): Promise<void> {
    if (!isAssistantMessage(message, ownerUserId)) return;
    if (!aiConfig?.enabled || !aiConfig.apiKey) {
      await message.reply("Epi is connected, but its OpenAI key is not configured yet.");
      return;
    }

    const state = conversations.get(message.channelId) ?? emptyConversation();
    const principal = await issueOwnerPrincipal(database.db, ownerUserId, {
      source: "discord",
      audience: "private",
      initiator: "assistant",
    });
    const budget = createBudget(
      {
        monthlyLimitUsd: aiConfig.monthlyBudgetUsd,
        warnPercent: aiConfig.warnPercent,
        timezone: aiConfig.timezone,
      },
      createDbUsageStore(database.db, ownerUserId),
      clock,
    );
    const assistant = createAssistant({
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
      clock,
    });
    const result = await assistant.handle(principal, message.content, state);
    conversations.set(message.channelId, result.state);
    await message.reply(result.reply.text);
  }
}
