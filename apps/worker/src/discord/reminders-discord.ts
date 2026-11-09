import { ChannelType, DiscordAPIError, PermissionFlagsBits, type Client } from "discord.js";
import type { Database } from "@epiphany/core/db";
import {
  createServices,
  resolveDiscordPrincipal,
  type Principal,
  type Services,
} from "@epiphany/core/services";
import { loadOverviewData, renderBriefing } from "@epiphany/core/overview";
import type { Reminder } from "@epiphany/core/db";
import {
  parseReminderSettings,
  runReminderCycle,
  syncReminders,
  type DeliveryResult,
  type ReminderDelivery,
} from "@epiphany/core/reminders";
import { errorDetails } from "../error-details";
import {
  LEARNING_CHECK_IN_PREFIX,
  fallbackMorningGreeting,
  parseMorningGreeting,
} from "@epiphany/core/assistant";
import { learningCheckInBlocker, scheduleLearningCheckIn } from "./learning-check-ins";

const confirmed = (row: { key: string; status: string }, key: string) =>
  row.key === key && row.status === "confirmed";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "discord", event, ...fields }),
  );
}

// Delivers only to the owner's private Epiphany #check-ins channel, or #well-being for learning
// questions (falling back to #check-ins in a workspace set up before it existed). It will not fall
// back to a public/look-alike channel or DM, so personal reminders cannot leak across destinations.
// With `speak`, the text is sent first and an optional audio clip follows in the same channel; any
// voice failure leaves the delivered text as it is.
export type SpeakCheckIn = (
  text: string,
  kind: "well-being" | "reminder" | "briefing",
) => Promise<Uint8Array | null>;

export function serverChannelDelivery(
  client: Client,
  ownerUserId: string,
  speak?: SpeakCheckIn,
): ReminderDelivery {
  return {
    async send(text, reminders): Promise<DeliveryResult> {
      const learning =
        !!reminders?.length &&
        reminders.every((reminder) => reminder.message.startsWith(LEARNING_CHECK_IN_PREFIX));
      const names = learning ? ["well-being", "check-ins"] : ["check-ins"];
      for (const name of names) {
        const result = await sendTo(name, text, reminders, learning);
        if (result.ok || result.reason !== "blocked") return result;
      }
      return { ok: false, reason: "blocked" };
    },
  };

  async function sendTo(
    name: string,
    text: string,
    reminders: Reminder[] | undefined,
    learning: boolean,
  ): Promise<DeliveryResult> {
    try {
      const botUser = client.user;
      if (!botUser) return { ok: false, reason: "error" };
      for (const guild of client.guilds.cache.values()) {
        let channels;
        try {
          channels = await guild.channels.fetch();
        } catch (error) {
          if (error instanceof DiscordAPIError && Number(error.code) === 50001) continue;
          throw error;
        }
        const channel = channels.find(
          (candidate) =>
            candidate?.type === ChannelType.GuildText &&
            candidate.name.toLowerCase() === name &&
            candidate.parent?.name.toLowerCase() === "epiphany" &&
            candidate.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ===
              false &&
            candidate.permissionsFor(botUser)?.has(PermissionFlagsBits.SendMessages),
        );
        if (!channel || channel.type !== ChannelType.GuildText) continue;
        let owner;
        try {
          owner = await guild.members.fetch(ownerUserId);
        } catch (error) {
          if (error instanceof DiscordAPIError && Number(error.code) === 10007) continue;
          throw error;
        }
        if (!owner.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)) continue;
        const marker = reminders?.length === 1 ? `\n-# epi:reminder:${reminders[0]!.id}` : "";
        const message = await channel.send({
          content: `<@${ownerUserId}> ${text}`.slice(0, 2000 - marker.length) + marker,
          allowedMentions: { parse: [], users: [ownerUserId] },
        });
        if (speak) {
          try {
            const spoken = learning ? text.replace(LEARNING_CHECK_IN_PREFIX, "") : text;
            const briefing = !!reminders?.length && reminders.every((r) => r.kind === "briefing");
            const audio = await speak(
              spoken,
              learning ? "well-being" : briefing ? "briefing" : "reminder",
            );
            if (audio) {
              await channel.send({
                files: [{ attachment: Buffer.from(audio), name: "epi-check-in.mp3" }],
                allowedMentions: { parse: [] },
              });
            }
          } catch {
            log("spoken_check_in_failed");
          }
        }
        return { ok: true, channelId: message.channelId };
      }
      return { ok: false, reason: "blocked" };
    } catch (error) {
      if (error instanceof DiscordAPIError) {
        if (error.status === 429) {
          return { ok: false, reason: "rate_limited", retryAfterMs: 60_000 };
        }
      }
      return { ok: false, reason: "error" };
    }
  }
}

export interface ReminderRunner {
  run(): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

// Runs the reminder service on a timer: keep the jobs in step with the records, then deliver what
// is due. Reminders make no AI call, so they keep working when OpenAI is down; only the optional,
// budgeted learning question may use one, and it falls back to a fixed question. A cycle
// that is still running when the next tick arrives is not started twice.
export function createReminderRunner(options: {
  client: Client;
  db: Database;
  ownerUserId: string;
  timezone: string;
  clock?: () => Date;
  learningCheckIns?: boolean;
  // Writes a question from the owner's own records (AI, budgeted); null uses a fixed question.
  composeLearningQuestion?: (input: {
    services: Services;
    principal: Principal;
    now: Date;
    recentQuestions: string[];
  }) => Promise<string | null>;
  canAskLearning?: () => boolean;
  // Writes the briefing's Jarvis-style opening line (AI, budgeted); null uses a fixed greeting.
  composeMorningGreeting?: (input: {
    services: Services;
    principal: Principal;
    now: Date;
    address: string | null;
  }) => Promise<string | null>;
  // Optional audio for delivered check-ins; returns null when the owner has not turned it on.
  speakCheckIn?: SpeakCheckIn;
  // Called after a reminder was delivered, so a reply in that private channel can be tied to it.
  // `learningQuestion` is the morning greeting when learning is allowed, so the reply can teach Epi.
  onDelivered?: (
    reminders: Reminder[],
    result: { channelId?: string; learningQuestion?: string },
  ) => void | Promise<void>;
}): ReminderRunner {
  const { client, db, ownerUserId, timezone } = options;
  const clock = options.clock ?? (() => new Date());
  const delivery = serverChannelDelivery(client, ownerUserId, options.speakCheckIn);
  let running = false;
  // Logged only when it changes, so the worker log explains a missing question without spam.
  let learningStatus = "";
  const noteLearning = (status: string) => {
    if (status !== learningStatus) log("learning_check_in", { status });
    learningStatus = status;
  };
  let timer: ReturnType<typeof setInterval> | undefined;

  async function run(): Promise<void> {
    if (running || !client.user) return;
    running = true;
    try {
      const principal = await resolveDiscordPrincipal(db, ownerUserId, {
        audience: "private",
        initiator: "assistant",
      });
      if (!principal) return;
      const services = createServices(db, { clock });
      const now = clock();
      if (!options.learningCheckIns) noteLearning("ai_not_configured");
      else if (!(options.canAskLearning?.() ?? true)) noteLearning("conversation_waiting");
      else {
        try {
          const compose = options.composeLearningQuestion;
          noteLearning(
            await scheduleLearningCheckIn(
              services,
              principal,
              now,
              timezone,
              compose
                ? (recentQuestions) => compose({ services, principal, now, recentQuestions })
                : undefined,
            ),
          );
        } catch (error) {
          log("learning_check_in_unavailable", errorDetails(error));
        }
      }
      const rows = await services.preferences.list(principal);
      const settings = parseReminderSettings(rows, now);
      const learningAllowed =
        rows.some((r) => confirmed(r, "tracking.enabled") && r.value === true) &&
        !rows.some((r) => confirmed(r, "tracking.paused") && r.value === true);
      const greetings = new Map<string, string>();
      const scheduled = await syncReminders({
        db,
        ownerId: principal.ownerId,
        now,
        timezone,
        settings,
      });
      const report = await runReminderCycle({
        db,
        ownerId: principal.ownerId,
        now,
        timezone,
        settings,
        delivery,
        eligible: async (reminder) => {
          if (!reminder.message.startsWith(LEARNING_CHECK_IN_PREFIX)) return true;
          const reason = !options.learningCheckIns
            ? "ai_not_configured"
            : !(options.canAskLearning?.() ?? true)
              ? "conversation_waiting"
              : now.getTime() - reminder.dueAt.getTime() >= 30 * 60_000
                ? "too_late"
                : await learningCheckInBlocker(services, principal, now, timezone);
          if (reason) log("learning_check_in_dropped", { reason });
          return !reason;
        },
        compose: async (reminder) => {
          if (reminder.kind !== "briefing") return null;
          const briefing = renderBriefing(
            await loadOverviewData(services, principal, now, timezone),
          );
          const setting = parseMorningGreeting(
            rows.find((r) => confirmed(r, "briefing.greeting"))?.value,
          );
          if (!setting.enabled) return briefing;
          let greeting: string | null = null;
          try {
            greeting =
              (await options.composeMorningGreeting?.({
                services,
                principal,
                now,
                address: setting.address,
              })) ?? null;
          } catch (error) {
            log("morning_greeting_unavailable", errorDetails(error));
          }
          greeting ??= fallbackMorningGreeting(setting.address);
          greetings.set(reminder.id, greeting);
          return `${greeting}\n\n${briefing}`;
        },
        ...(options.onDelivered
          ? {
              onDelivered: (delivered: Reminder[], result: { channelId?: string }) => {
                const greeting =
                  delivered.length === 1 ? greetings.get(delivered[0]!.id) : undefined;
                return options.onDelivered!(
                  delivered,
                  greeting && learningAllowed ? { ...result, learningQuestion: greeting } : result,
                );
              },
            }
          : {}),
      });
      const active = Object.values(report).some((count) => count > 0);
      if (active || scheduled.created > 0 || scheduled.canceled > 0) {
        log("reminder_cycle", {
          ...report,
          scheduled: scheduled.created,
          canceled: scheduled.canceled,
        });
      }
    } catch (error) {
      log("reminder_cycle_failed", errorDetails(error));
    } finally {
      running = false;
    }
  }

  return {
    run,
    start(intervalMs) {
      timer ??= setInterval(() => void run(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
