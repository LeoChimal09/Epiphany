// Errors from the Google Calendar and OAuth endpoints. None of them carries a token, a request
// body, or a response body; only status codes and Google's short machine-readable reason.

export class GoogleApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  constructor(status: number, reason: string | null, message?: string) {
    super(message ?? `Google Calendar request failed (${status}${reason ? `, ${reason}` : ""}).`);
    this.name = "GoogleApiError";
    this.status = status;
    this.reason = reason;
  }
}

// 410: the incremental sync token expired or the resource is gone.
export class GoogleGoneError extends GoogleApiError {
  constructor(reason: string | null) {
    super(410, reason, "Google no longer accepts the saved sync position (410 Gone).");
    this.name = "GoogleGoneError";
  }
}

// 412: the event's ETag no longer matches, so it changed since it was last read.
export class GooglePreconditionError extends GoogleApiError {
  constructor() {
    super(
      412,
      "conditionNotMet",
      "The event changed in Google Calendar (412 Precondition Failed).",
    );
    this.name = "GooglePreconditionError";
  }
}

export class GoogleNotFoundError extends GoogleApiError {
  constructor() {
    super(404, "notFound", "Not found in Google Calendar (404).");
    this.name = "GoogleNotFoundError";
  }
}

// 409: for example an event with that ID already exists.
export class GoogleConflictError extends GoogleApiError {
  constructor() {
    super(409, "duplicate", "Google Calendar reports the item already exists (409).");
    this.name = "GoogleConflictError";
  }
}

// The access token was refused even after a refresh, or the grant lacks the needed scope.
export class GoogleAuthError extends GoogleApiError {
  constructor(status: number, reason: string | null) {
    super(status, reason, `Google Calendar refused the saved authorization (${status}).`);
    this.name = "GoogleAuthError";
  }
}

export class GoogleRateLimitError extends GoogleApiError {
  readonly retryAfterMs: number | null;
  constructor(status: number, reason: string | null, retryAfterMs: number | null) {
    super(status, reason, "Google Calendar rate limit reached; retries were exhausted.");
    this.name = "GoogleRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// A write (create/update) may or may not have reached Google: a timeout, a dropped connection, or
// a 5xx. It is never retried blindly; the caller reconciles by looking the event up first.
export class UncertainWriteError extends Error {
  constructor(cause?: unknown) {
    super("The write to Google Calendar may or may not have happened.", { cause });
    this.name = "UncertainWriteError";
  }
}

// The refresh token was rejected (revoked, expired, or the owner removed access): the account needs
// the owner to connect again. Nothing retries this.
export class GoogleInvalidGrantError extends Error {
  constructor() {
    super("Google rejected the saved authorization (invalid_grant); the owner must reconnect.");
    this.name = "GoogleInvalidGrantError";
  }
}

// Refreshing failed for a reason that may pass (network, Google outage).
export class GoogleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTokenError";
  }
}
