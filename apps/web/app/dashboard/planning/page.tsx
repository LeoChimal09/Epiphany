import Link from "next/link";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { parsePlanningPreferences } from "@epiphany/core/planning";
import { parseReminderSettings } from "@epiphany/core/reminders";
import { buildInsights } from "@epiphany/core/insights";
import { dashboardContext } from "../server-data";
import { PlanningSettings } from "./settings";
import { BriefingSettings, SplitReminderSettings } from "../reminders/settings";
import styles from "./settings.module.css";

export const dynamic = "force-dynamic";

export default async function PlanningPage() {
  const { principal, services, timezone } = await dashboardContext();
  const rows = await services.preferences.list(principal);
  const preferences = parsePlanningPreferences(rows, timezone);
  const reminderSettings = parseReminderSettings(rows);
  const versions = Object.fromEntries(rows.map((row) => [row.key, row.version]));
  const enabled = rows.some(
    (row) => row.key === "tracking.enabled" && row.status === "confirmed" && row.value === true,
  );
  const paused = rows.some(
    (row) => row.key === "tracking.paused" && row.status === "confirmed" && row.value === true,
  );
  const insights =
    enabled && !paused
      ? buildInsights(await services.insights.list(principal)).map((insight) => insight.text)
      : [];
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/dashboard" className={styles.back}>
          <ArrowLeft size={15} aria-hidden="true" /> Back to dashboard
        </Link>
        <h1>
          <SlidersHorizontal size={24} aria-hidden="true" /> Planning defaults
        </h1>
        <p>Rows show saved defaults, not individual plans. Times in {timezone}.</p>
      </header>
      <PlanningSettings
        preferences={preferences}
        versions={versions}
        learning={{
          enabled,
          paused,
          insights,
          checkIns: rows.some(
            (row) =>
              row.key === "tracking.check_ins" && row.status === "confirmed" && row.value === true,
          ),
        }}
        notifications={
          <>
            <p className={styles.groupNote}>
              Default delivery in {timezone}. Individual reminder choices take priority.
            </p>
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
          </>
        }
      />
    </main>
  );
}
