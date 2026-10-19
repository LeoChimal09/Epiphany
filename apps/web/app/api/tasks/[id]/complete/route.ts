import { completeTask } from "@/lib/api/tasks";
import { getAuthDeps, notConfigured } from "@/lib/auth/deps";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const deps = getAuthDeps();
  if (!deps) return notConfigured();
  const { id } = await context.params;
  return completeTask(request, deps, id);
}
