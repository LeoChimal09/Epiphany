"use server";

import { redirect } from "next/navigation";
import { CalendarError } from "@epiphany/core/calendar";
import { ValidationError } from "@epiphany/core/services";
import { verifySession } from "../../../lib/auth/dal";
import { calendarServices, getGoogleDeps } from "../../../lib/google/deps";

const PAGE = "/dashboard/calendars";

async function context() {
  const principal = await verifySession();
  const deps = getGoogleDeps();
  if (!deps) redirect("/login");
  return { principal, services: calendarServices(deps) };
}

function reason(error: unknown): string {
  if (error instanceof ValidationError) return "invalid";
  if (error instanceof CalendarError) {
    return error.code === "not_configured" ? "not_configured" : "failed";
  }
  return "failed";
}

export async function saveCalendarSelection(form: FormData): Promise<void> {
  const { principal, services } = await context();
  const ids = form.getAll("calendar").filter((value): value is string => typeof value === "string");
  let outcome = "saved";
  try {
    await services.calendar.select(principal, ids);
  } catch (error) {
    outcome = reason(error);
  }
  redirect(`${PAGE}?notice=${outcome}`);
}

export async function resolveCalendarConflict(form: FormData): Promise<void> {
  const { principal, services } = await context();
  const blockId = form.get("blockId");
  const choice = form.get("choice");
  let outcome = "resolved";
  try {
    await services.calendar.resolveConflict(principal, blockId, choice);
  } catch (error) {
    outcome = reason(error);
  }
  redirect(`${PAGE}?notice=${outcome}`);
}
