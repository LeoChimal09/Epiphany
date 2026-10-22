import { DiscordAPIError, type Client } from "discord.js";
import type { Database } from "@epiphany/core/db";
import { createServices, resolveDiscordPrincipal } from "@epiphany/core/services";
import { loadOverviewData, renderBriefing } from "@epiphany/core/overview";
import type { Reminder } from "@epiphany/core/db";
import {
  parseReminderSettings,
  runReminderCycle,
  syncReminders,
  type DeliveryResult,
  type ReminderDelivery,
} from "@epiphany/core/reminders";

// Discord error code for "Cannot send messages to this user" (DMs closed or blocked).
const CANNOT_DM = 50007;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "discord", event, ...fields }),
  );
}

// Sends a reminder as a DM to the owner. Closed DMs are reported as "blocked" (retrying cannot
// help); a rate limit or any other failure is reported so the engine can back off and retry.
export function dmDelivery(client: Client, ownerUserId: string): ReminderDelivery {
  return {
    async send(text): Promise<DeliveryResult> {
      try {
        const owner = await client.users.fetch(ownerUserId);
        const message = await owner.send({
          content: text.slice(0, 2000),
          allowedMentions: { parse: [] },
        });
        return { ok: true, channelId: message.channelId };
      } catch (error) {
        if (error instanceof DiscordAPIError) {
          if (Number(error.code) === CANNOT_DM) return { ok: false, reason: "blocked" };
          if (error.status === 429) {
            return { ok: false, reason: "rate_limited", retryAfterMs: 60_000 };
          }
        }
        return { ok: false, reason: "error" };
      }
    },
  };
}

export interface ReminderRunner {
  run(): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

// Runs the reminder service on a timer: keep the jobs in step with the records, then deliver what
// is due. It reads no model and makes no AI call, so it keeps working when OpenAI is down. A cycle
// that is still running when the next tick arrives is not started twice.
export function createReminderRunner(options: {
  client: Client;
  db: Database;
  ownerUserId: string;
  timezone: string;
  clock?: () => Date;
  // Called after a reminder DM was delivered, so a reply in that DM can be tied to it.
  onDelivered?: (reminders: Reminder[], result: { channelId?: string }) => void | Promise<void>;
}): ReminderRunner {
  const { client, db, ownerUserId, timezone } = options;
  const clock = options.clock ?? (() => new Date());
  const delivery = dmDelivery(client, ownerUserId);
  let running = false;
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
      const settings = parseReminderSettings(await services.preferences.list(principal), now);
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
        compose: async (reminder) =>
          reminder.kind === "briefing"
            ? renderBriefing(await loadOverviewData(services, principal, now, timezone))
            : null,
        ...(options.onDelivered ? { onDelivered: options.onDelivered } : {}),
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
      log("reminder_cycle_failed", { error: error instanceof Error ? error.name : "unknown" });
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
