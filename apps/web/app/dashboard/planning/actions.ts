"use server";

import { revalidatePath } from "next/cache";
import { validatePlanningSetting } from "@epiphany/core/planning";
import { ValidationError, VersionConflictError } from "@epiphany/core/services";
import { dashboardContext } from "../server-data";

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
      value: validated,
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
