import { getAuthDeps, notConfigured } from "@/lib/auth/deps";
import { devLogin } from "@/lib/auth/handlers";

export const dynamic = "force-dynamic";

// Development-only sign-in (ENV_BYPASS=dev). devLogin answers 404 unless the bypass is enabled.
// Only POST is exported, so a link or image tag can never trigger a sign-in.
export async function POST(request: Request) {
  const deps = getAuthDeps();
  return deps ? devLogin(request, deps) : notConfigured();
}
