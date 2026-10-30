"use client";

import { CloudOff } from "lucide-react";
import styles from "./calendars/calendars.module.css";

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <CloudOff size={23} aria-hidden="true" />
        </span>
        <h1>Dashboard unavailable</h1>
        <p>Your saved records could not be loaded. Try again to reconnect.</p>
      </header>
      <div className={styles.actions}>
        <button className={styles.primary} type="button" onClick={reset}>
          Try again
        </button>
        <form action="/api/auth/logout" method="post">
          <button className={styles.secondary} type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
