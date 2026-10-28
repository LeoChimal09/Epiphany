"use server";

import { revalidatePath } from "next/cache";
import { ValidationError, VersionConflictError } from "@epiphany/core/services";
import { dashboardContext } from "../server-data";
import { splitReminderSchema } from "@epiphany/core/reminders";

const BRIEFING_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export async function saveSplitReminderSetting(
  value: unknown,
  expectedVersion: number | undefined,
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const { principal, services } = await dashboardContext();
  const parsed = splitReminderSchema.safeParse(value);
  if (!parsed.success)
    return { ok: false, error: "Choose a whole reminder count from 1 to 100. Nothing was saved." };
  try {
    const saved = await services.preferences.set(principal, {
      key: "reminders.split",
      value: parsed.data,
      status: "confirmed",
      expectedVersion,
    });
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/planning");
    return { ok: true, version: saved.version };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.issues.join(". ") };
    if (error instanceof VersionConflictError)
      return { ok: false, error: "This setting changed elsewhere. Reload before saving." };
    console.error(JSON.stringify({ service: "dashboard", event: "split_preference_save_failed" }));
    return { ok: false, error: "Split reminder settings could not be saved. Try again." };
  }
}

export async function saveBriefingSetting(
  value: unknown,
  expectedVersion: number | undefined,
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const { principal, services } = await dashboardContext();
  if (value !== null && (typeof value !== "string" || !BRIEFING_TIME.test(value))) {
    return { ok: false, error: "Choose a valid local time. Nothing was saved." };
  }
  try {
    const saved = await services.preferences.set(principal, {
      key: "reminders.briefing_time",
      value: value ?? false,
      status: "confirmed",
      expectedVersion,
    });
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/planning");
    return { ok: true, version: saved.version };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.issues.join(". ") };
    if (error instanceof VersionConflictError)
      return { ok: false, error: "This setting changed elsewhere. Reload before saving." };
    console.error(
      JSON.stringify({ service: "dashboard", event: "briefing_preference_save_failed" }),
    );
    return { ok: false, error: "The briefing setting could not be saved. Try again." };
  }
}
