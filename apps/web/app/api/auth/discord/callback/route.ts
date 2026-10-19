import { getAuthDeps, notConfigured } from "@/lib/auth/deps";
import { finishLogin } from "@/lib/auth/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const deps = getAuthDeps();
  return deps ? finishLogin(request, deps) : notConfigured();
}
