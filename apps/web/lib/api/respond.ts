import { NotFoundError } from "@epiphany/core/db";
import {
  AccessDeniedError,
  ConfirmationError,
  ConfirmationRequiredError,
  ValidationError,
  type Principal,
} from "@epiphany/core/services";
import { isSameOrigin, principalFromRequest, type AuthDeps } from "../auth/handlers";

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function toErrorResponse(error: unknown): Response {
  if (error instanceof ValidationError)
    return json({ error: "invalid", issues: error.issues }, 422);
  if (error instanceof AccessDeniedError)
    return json({ error: "forbidden", reason: error.message }, 403);
  if (error instanceof ConfirmationRequiredError) {
    return json({ error: "confirmation_required", kind: error.kind, reason: error.message }, 409);
  }
  if (error instanceof ConfirmationError)
    return json({ error: error.failure, reason: error.message }, 409);
  if (error instanceof NotFoundError) return json({ error: "not_found" }, 404);
  console.error(
    JSON.stringify({
      service: "web",
      event: "api_error",
      message: error instanceof Error ? error.message : "unknown",
    }),
  );
  return json({ error: "internal" }, 500);
}

const MAX_BODY_BYTES = 100_000;

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ValidationError(["request body must be application/json"]);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ValidationError(["request body is too large"]);
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError(["request body is not valid JSON"]);
  }
}

// Every API route goes through here: same-origin check for changes, then an authenticated owner
// principal, then the action. Authorization itself happens again inside the services.
export async function handleApi(
  request: Request,
  deps: AuthDeps,
  action: (principal: Principal) => Promise<unknown>,
  successStatus = 200,
): Promise<Response> {
  try {
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !isSameOrigin(request, deps.config)
    ) {
      return json({ error: "forbidden", reason: "cross-origin request" }, 403);
    }
    const principal = await principalFromRequest(request, deps);
    if (!principal) return json({ error: "unauthenticated" }, 401);
    return json(await action(principal), successStatus);
  } catch (error) {
    return toErrorResponse(error);
  }
}
