"use server";

import { revalidatePath } from "next/cache";
import { validatePlanningSetting } from "@epiphany/core/planning";
import { ValidationError, VersionConflictError } from "@epiphany/core/services";
import { dashboardContext } from "../server-data";

export async function saveLearningAllowance(
  allowed: boolean,
  expectedVersion: number | undefined,
  pausedVersion: number | undefined,
  consent: boolean,
): Promise<{ ok: true; version: number; pausedVersion?: number } | { ok: false; error: string }> {
  const saved = await saveLearningSetting("tracking.enabled", allowed, expectedVersion, consent);
  if (!saved.ok || !allowed) return saved;
  const resumed = await saveLearningSetting("tracking.paused", false, pausedVersion, false);
  if (!resumed.ok) {
    return {
      ok: false,
      error:
        "Learning permission was saved, but could not be fully applied. Reload to review its current state.",
    };
  }
  return { ok: true, version: saved.version, pausedVersion: resumed.version };
}

export async function saveLearningSetting(
  key: "tracking.enabled" | "tracking.paused" | "tracking.check_ins",
  value: boolean,
  expectedVersion: number | undefined,
  consent: boolean,
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const { principal, services } = await dashboardContext();
  if (
    (key !== "tracking.enabled" && key !== "tracking.paused" && key !== "tracking.check_ins") ||
    typeof value !== "boolean"
  )
    return { ok: false, error: "Invalid learning setting." };
  if ((key === "tracking.enabled" || key === "tracking.check_ins") && value && consent !== true)
    return { ok: false, error: "Enabling learning requires your explicit consent." };
  try {
    const saved = await services.preferences.set(principal, {
      key,
      value,
      status: "confirmed",
      expectedVersion,
    });
    revalidatePath("/dashboard/planning");
    return { ok: true, version: saved.version };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof VersionConflictError
          ? "Learning settings changed elsewhere. Reload before saving."
          : "Learning settings could not be saved.",
    };
  }
}

export async function savePlanningSetting(
  key: string,
  value: unknown,
  expectedVersion: number | undefined,
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const { principal, services } = await dashboardContext();
  let validated;
  try {
    validated = validatePlanningSetting(key, value);
  } catch {
    return { ok: false, error: "Check the times and limits. Nothing was saved." };
  }
  try {
    const saved = await services.preferences.set(principal, {
      key,
      value: validated === null ? false : validated,
      status: "confirmed",
      expectedVersion,
    });
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/planning");
    return { ok: true, version: saved.version };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.issues.join(". ") };
    if (error instanceof VersionConflictError)
      return { ok: false, error: "These settings changed elsewhere. Reload before saving." };
    console.error(
      JSON.stringify({ service: "dashboard", event: "planning_preferences_save_failed" }),
    );
    return { ok: false, error: "Settings could not be saved. Try again." };
  }
}
