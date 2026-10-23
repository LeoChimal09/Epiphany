import { getGoogleDeps } from "@/lib/google/deps";
import { notConfigured } from "@/lib/auth/deps";
import { disconnect } from "@/lib/google/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const deps = getGoogleDeps();
  return deps ? disconnect(request, deps) : notConfigured();
}
