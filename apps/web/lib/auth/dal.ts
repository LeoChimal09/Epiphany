import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { principalFromSession } from "@epiphany/core/auth";
import { getAuthDeps } from "./deps";
import { cookieNames } from "./cookies";

// Data access layer: every page that shows personal data calls this, so authorization never
// depends on a proxy or layout check alone.
export const verifySession = cache(async () => {
  const deps = getAuthDeps();
  if (!deps) redirect("/login");
  const names = cookieNames(deps.config.secureCookies);
  const token = (await cookies()).get(names.session)?.value;
  const principal = await principalFromSession(deps.db, token);
  if (!principal) redirect("/login");
  return principal;
});
