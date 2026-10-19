import { ConfigError, loadAuthConfig } from "@epiphany/core";
import { getDb } from "../db";
import { createDiscordClient } from "./discord";
import type { AuthDeps } from "./handlers";

// Sign-in is optional configuration: until it is set up, routes answer 503 and the login page
// explains. Details go to the server log, not to the browser.
export function getAuthDeps(): AuthDeps | null {
  try {
    const config = loadAuthConfig(process.env);
    return { db: getDb(), config, discord: createDiscordClient(config) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    return null;
  }
}

export const notConfigured = () =>
  Response.json({ error: "sign_in_not_configured" }, { status: 503 });
