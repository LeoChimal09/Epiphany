import "server-only";
import { ConfigError, googleCalendarRequested, loadGoogleConfig } from "@epiphany/core";
import { createServices } from "@epiphany/core/services";
import { getAuthDeps } from "../auth/deps";
import type { GoogleDeps } from "./handlers";
import { createGoogleOAuthClient } from "./oauth";

let reported = false;

// Google Calendar is optional configuration. Until it is complete, connecting answers with an
// actionable message and the rest of the dashboard is unaffected. Details go to the server log
// only (never the values).
export function getGoogleDeps(): GoogleDeps | null {
  const auth = getAuthDeps();
  if (!auth) return null;
  try {
    const config = loadGoogleConfig(process.env);
    return {
      auth,
      oauth: createGoogleOAuthClient(config, auth.config.appUrl),
      calendar: {
        tokenKey: config.tokenKey,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      },
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (googleCalendarRequested(process.env) && !reported) {
      reported = true;
      console.error(error.message);
    }
    return { auth, oauth: null, calendar: null };
  }
}

export function calendarServices(deps: GoogleDeps) {
  return createServices(deps.auth.db, {
    clock: deps.auth.clock,
    ...(deps.calendar ? { calendar: deps.calendar } : {}),
  });
}
