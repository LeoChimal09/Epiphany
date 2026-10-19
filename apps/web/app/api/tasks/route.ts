import { createTask, listTasks } from "@/lib/api/tasks";
import { getAuthDeps, notConfigured } from "@/lib/auth/deps";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const deps = getAuthDeps();
  return deps ? listTasks(request, deps) : notConfigured();
}

export async function POST(request: Request) {
  const deps = getAuthDeps();
  return deps ? createTask(request, deps) : notConfigured();
}
