import Link from "next/link";
import { parsePlanningPreferences } from "@epiphany/core/planning";
import { dashboardContext } from "../server-data";
import { PlanningSettings } from "./settings";
import styles from "../calendars/calendars.module.css";

export const dynamic = "force-dynamic";

export default async function PlanningPage() {
  const { principal, services, timezone } = await dashboardContext();
  const rows = await services.preferences.list(principal);
  const preferences = parsePlanningPreferences(rows, timezone);
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/dashboard" className={styles.back}>
          Back to dashboard
        </Link>
        <h1>Scheduling preferences</h1>
      </header>
      <p className={styles.muted}>
        Times are in {timezone}. These rules guide availability and Epi&apos;s scheduling. They
        never move existing appointments or book time automatically. Each section loads existing
        settings or conservative defaults. Defaults are not assumed facts about you; changes take
        effect only when you save that section.
      </p>
      <PlanningSettings
        preferences={preferences}
        versions={Object.fromEntries(rows.map((row) => [row.key, row.version]))}
      />
    </main>
  );
}
