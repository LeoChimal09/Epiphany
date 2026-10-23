import { getGoogleDeps } from "@/lib/google/deps";
import { notConfigured } from "@/lib/auth/deps";
import { startConnect } from "@/lib/google/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const deps = getGoogleDeps();
  return deps ? startConnect(request, deps) : notConfigured();
}
