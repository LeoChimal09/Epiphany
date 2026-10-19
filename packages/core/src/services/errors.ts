export class AccessDeniedError extends Error {
  readonly action: string;
  constructor(action: string, reason: string) {
    super(`${action} denied: ${reason}`);
    this.name = "AccessDeniedError";
    this.action = action;
  }
}

// The action is valid but must go through proposeAction/confirmAction (or an explicit
// consent flow) instead of being called directly.
export class ConfirmationRequiredError extends Error {
  readonly action: string;
  readonly kind: "confirm" | "consent";
  constructor(action: string, kind: "confirm" | "consent", reason: string) {
    super(`${action} needs ${kind === "consent" ? "explicit consent" : "confirmation"}: ${reason}`);
    this.name = "ConfirmationRequiredError";
    this.action = action;
    this.kind = kind;
  }
}

export type ConfirmationFailure =
  "not_found" | "already_resolved" | "expired" | "mismatch" | "stale";

export class ConfirmationError extends Error {
  readonly failure: ConfirmationFailure;
  constructor(failure: ConfirmationFailure, message: string) {
    super(message);
    this.name = "ConfirmationError";
    this.failure = failure;
  }
}

export class ValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid input:\n- ${issues.join("\n- ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}
