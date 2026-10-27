import Link from "next/link";
import { parsePlanningPreferences } from "@epiphany/core/planning";
import { parseReminderSettings } from "@epiphany/core/reminders";
import { dashboardContext } from "../server-data";
import { PlanningSettings } from "./settings";
import { BriefingSettings } from "../reminders/settings";
import styles from "../calendars/calendars.module.css";

export const dynamic = "force-dynamic";

export default async function PlanningPage() {
  const { principal, services, timezone } = await dashboardContext();
  const rows = await services.preferences.list(principal);
  const preferences = parsePlanningPreferences(rows, timezone);
  const briefingTime = parseReminderSettings(rows).briefingTime;
  const versions = Object.fromEntries(rows.map((row) => [row.key, row.version]));
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/dashboard" className={styles.back}>
          Back to dashboard
        </Link>
        <h1>Scheduling preferences</h1>
      </header>
      <p className={styles.muted}>Times use AM/PM in {timezone}.</p>
      <BriefingSettings
        briefingTime={briefingTime}
        timezone={timezone}
        version={versions["reminders.briefing_time"]}
      />
      <PlanningSettings preferences={preferences} versions={versions} />
    </main>
  );
}
