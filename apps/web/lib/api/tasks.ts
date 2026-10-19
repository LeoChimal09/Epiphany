import { createServices } from "@epiphany/core/services";
import type { AuthDeps } from "../auth/handlers";
import { handleApi, readJson } from "./respond";

export function listTasks(request: Request, deps: AuthDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const input: Record<string, unknown> = {};
  const status = params.get("status");
  if (status) input.status = status;
  if (params.has("limit")) input.limit = Number(params.get("limit"));
  if (params.has("offset")) input.offset = Number(params.get("offset"));
  if (params.has("includeArchived"))
    input.includeArchived = params.get("includeArchived") === "true";

  return handleApi(request, deps, (principal) =>
    createServices(deps.db, { clock: deps.clock }).tasks.list(principal, input),
  );
}

export function createTask(request: Request, deps: AuthDeps): Promise<Response> {
  return handleApi(
    request,
    deps,
    async (principal) =>
      createServices(deps.db, { clock: deps.clock }).tasks.create(
        principal,
        await readJson(request),
      ),
    201,
  );
}

export function completeTask(request: Request, deps: AuthDeps, taskId: string): Promise<Response> {
  return handleApi(request, deps, (principal) =>
    createServices(deps.db, { clock: deps.clock }).tasks.complete(principal, taskId),
  );
}
