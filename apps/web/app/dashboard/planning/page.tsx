import Link from "next/link";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { parsePlanningPreferences } from "@epiphany/core/planning";
import { parseReminderSettings } from "@epiphany/core/reminders";
import { dashboardContext } from "../server-data";
import { PlanningSettings } from "./settings";
import { BriefingSettings, SplitReminderSettings } from "../reminders/settings";
import styles from "../calendars/calendars.module.css";

export const dynamic = "force-dynamic";

export default async function PlanningPage() {
  const { principal, services, timezone } = await dashboardContext();
  const rows = await services.preferences.list(principal);
  const preferences = parsePlanningPreferences(rows, timezone);
  const reminderSettings = parseReminderSettings(rows);
  const versions = Object.fromEntries(rows.map((row) => [row.key, row.version]));
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/dashboard" className={styles.back}>
          <ArrowLeft size={15} aria-hidden="true" /> Back to dashboard
        </Link>
        <span className={styles.headerIcon}>
          <SlidersHorizontal size={23} aria-hidden="true" />
        </span>
        <h1>Scheduling preferences</h1>
        <p>A plan that fits your life, not the other way around.</p>
      </header>
      <p className={styles.muted}>Times use AM/PM in {timezone}.</p>
      <BriefingSettings
        briefingTime={reminderSettings.briefingTime}
        timezone={timezone}
        version={versions["reminders.briefing_time"]}
      />
      <SplitReminderSettings
        value={reminderSettings.splitReminders}
        dailyLimit={reminderSettings.dailyLimit}
        version={versions["reminders.split"]}
      />
      <PlanningSettings preferences={preferences} versions={versions} />
    </main>
  );
}
