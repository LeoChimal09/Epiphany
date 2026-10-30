import { loadAuthConfig, type AuthConfig } from "@epiphany/core";
import {
  CalendarClock,
  FlaskConical,
  ListChecks,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  denied: "Sign-in was canceled.",
  invalid: "That sign-in attempt was not valid or expired. Please try again.",
  not_authorized: "That Discord account is not allowed to use this dashboard.",
  unavailable: "Sign-in is temporarily unavailable. Please try again.",
};

function readAuthConfig(): AuthConfig | null {
  try {
    return loadAuthConfig(process.env);
  } catch {
    return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const config = readAuthConfig();
  const discordReady = Boolean(config?.discordClientId && config.discordClientSecret);

  return (
    <main className={styles.page}>
      <div className={styles.layout}>
        <section className={styles.intro} aria-labelledby="welcome-heading">
          <p className={styles.kicker}>
            <Sparkles size={16} aria-hidden="true" /> Personal field station
          </p>
          <h2 id="welcome-heading">
            Make room for
            <br />
            <span>what matters.</span>
          </h2>
          <p className={styles.introLead}>
            The big plans. The small errands. The idea you don&apos;t want to lose. Give them a
            home, and give yourself some headspace.
          </p>
          <div className={styles.featureStack}>
            <div>
              <span className={styles.featureIcon}>
                <ListChecks size={21} aria-hidden="true" />
              </span>
              <p>
                <strong>One thing at a time</strong>
                <span>Tasks and todos, without the mental clutter.</span>
              </p>
            </div>
            <div>
              <span className={styles.featureIcon}>
                <CalendarClock size={21} aria-hidden="true" />
              </span>
              <p>
                <strong>See the shape of your day</strong>
                <span>Your commitments and deadlines, together.</span>
              </p>
            </div>
            <div>
              <span className={styles.featureIcon}>
                <Sparkles size={21} aria-hidden="true" />
              </span>
              <p>
                <strong>Keep the spark</strong>
                <span>A place for notes, ideas, and what comes next.</span>
              </p>
            </div>
          </div>
        </section>
        <div className={styles.card}>
          <div className={styles.glow} aria-hidden="true" />

          <div className={styles.hero}>
            <span className={styles.logo} aria-hidden="true">
              <Sparkles size={26} />
            </span>
            <div>
              <p className={styles.eyebrow}>Private workspace</p>
              <h1>Epiphany</h1>
            </div>
            <p className={styles.lead}>Your space to think, plan, and move forward.</p>
          </div>

          <ul className={styles.features} aria-label="What Epiphany does">
            <li>
              <ListChecks size={13} aria-hidden="true" /> Tasks
            </li>
            <li>
              <CalendarClock size={13} aria-hidden="true" /> Deadlines
            </li>
            <li>
              <Sparkles size={13} aria-hidden="true" /> Notes &amp; ideas
            </li>
          </ul>

          {error && MESSAGES[error] ? (
            <p role="alert" className={`${styles.notice} ${styles.error}`}>
              <TriangleAlert size={15} aria-hidden="true" />
              {MESSAGES[error]}
            </p>
          ) : null}

          {!config ? (
            <p role="alert" className={`${styles.notice} ${styles.error}`}>
              <TriangleAlert size={15} aria-hidden="true" />
              Sign-in is not set up yet. The owner needs to configure it (see
              docs/local-development.md).
            </p>
          ) : null}

          <div className={styles.actions}>
            {discordReady ? (
              <a className={`${styles.button} ${styles.discord}`} href="/api/auth/discord">
                <DiscordMark />
                Sign in with Discord
              </a>
            ) : null}

            {discordReady && config?.devBypass ? <div className={styles.divider}>or</div> : null}

            {config?.devBypass ? (
              <form action="/api/auth/dev" method="post">
                <button
                  type="submit"
                  className={`${styles.button} ${styles.dev} ${discordReady ? "" : styles.devPrimary}`}
                >
                  <FlaskConical size={17} aria-hidden="true" />
                  Continue as dev owner
                </button>
              </form>
            ) : null}
          </div>

          {config?.devBypass ? (
            <p role="status" className={`${styles.notice} ${styles.warning}`}>
              <ShieldAlert size={15} aria-hidden="true" />
              Local development access only. Use test data.
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function DiscordMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}
