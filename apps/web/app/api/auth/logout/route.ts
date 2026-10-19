import { getAuthDeps, notConfigured } from "@/lib/auth/deps";
import { logout } from "@/lib/auth/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const deps = getAuthDeps();
  return deps ? logout(request, deps) : notConfigured();
}
