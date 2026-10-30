import { AccessDeniedError, ConfirmationRequiredError } from "./errors";
import type { Principal } from "./principal";

// Internal policy from docs/operating-policies.md ("Action Permissions And Confirmation").
// Users never see these names; they ask in natural language and Epi maps the request to one.
type Kind =
  | "read" // view a schedule, history, or ask for advice: never mutates
  | "apply" // clear, explicit add/complete/snooze: applies and offers undo
  | "schedule" // create/move Epiphany's own work blocks: needs explicit scheduling intent
  | "external" // modify/cancel an external appointment or recurring series: confirm
  | "destructive" // delete, bulk-edit, clear memory, change protected time: confirm
  | "escalate"; // raise notification limits, enable tracking/listening, expand provider access

interface ActionSpec {
  kind: Kind;
  // The action becomes a confirm-class action when it touches an externally synced record.
  confirmWhenExternal?: boolean;
}

export const ACTIONS = {
  "task.read": { kind: "read" },
  "event.read": { kind: "read" },
  "work_block.read": { kind: "read" },
  "note.read": { kind: "read" },
  "preference.read": { kind: "read" },
  "preference.write": { kind: "apply" },
  "preference.delete": { kind: "destructive" },
  "history.read": { kind: "read" },
  "category.read": { kind: "read" },
  "owner.read": { kind: "read" },
  "task.create": { kind: "apply" },
  "task.complete": { kind: "apply" },
  "task.update": { kind: "apply" },
  "task.reopen": { kind: "apply" },
  "note.create": { kind: "apply" },
  "note.update": { kind: "apply" },
  "event.create": { kind: "apply" },
  "event.acknowledge": { kind: "apply" },
  "event.cancel": { kind: "apply", confirmWhenExternal: true },
  "event.cancel_series": { kind: "destructive" },
  "category.create": { kind: "apply" },
  "reminder.snooze": { kind: "apply" },
  "reminder.create": { kind: "apply" },
  "insight.read": { kind: "read" },
  "insight.write": { kind: "apply" },
  "reminder.read": { kind: "read" },
  "calendar.read": { kind: "read" },
  "calendar.connect": { kind: "escalate" }, // expands provider access: needs the owner's consent
  "calendar.disconnect": { kind: "apply" },
  "calendar.select": { kind: "apply" }, // chooses which calendars are read
  "calendar.resolve_conflict": { kind: "schedule" }, // the owner's choice about a changed Google event
  "overview.read": { kind: "read" },
  "overview.write": { kind: "apply" }, // records which Discord message shows an overview
  "workspace.setup": { kind: "apply" }, // adds Epiphany's own private channels; never edits others
  "work_block.create": { kind: "schedule" },
  "work_block.remove": { kind: "schedule" },
  "event.update_external": { kind: "external" },
  "note.delete": { kind: "destructive" },
  "task.delete": { kind: "destructive" },
  "record.bulk_edit": { kind: "destructive" },
  "memory.clear": { kind: "destructive" },
  "protected_time.change": { kind: "destructive" },
  "notification_limit.increase": { kind: "escalate" },
  "tracking.enable": { kind: "escalate" },
  "listening.enable": { kind: "escalate" },
  // One live voice session the owner explicitly asked for; it ends when they say so or after idling.
  "voice.session": { kind: "apply" },
  "provider_permission.expand": { kind: "escalate" },
} as const satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;

export type Decision =
  | { kind: "allow"; undoable: boolean }
  | { kind: "confirm"; reason: string }
  | { kind: "consent"; reason: string }
  | { kind: "deny"; reason: string };

export interface DecisionContext {
  // Whether the request explicitly asked for a schedule change, as opposed to asking for advice.
  intent?: "explicit" | "advice";
  // Whether the target is synced to an external calendar.
  external?: boolean;
}

// Personal data is never served to a shared audience. No action is exempt yet; widen
// deliberately (and test it) if a genuinely public-safe action is ever added.
const SHARED_SAFE: ReadonlySet<ActionName> = new Set();

export function decide(
  principal: Pick<Principal, "audience" | "initiator">,
  action: string,
  context: DecisionContext = {},
): Decision {
  const spec: ActionSpec | undefined = (ACTIONS as Record<string, ActionSpec>)[action];
  if (!spec) return { kind: "deny", reason: "unknown action" };

  if (principal.audience === "shared" && !SHARED_SAFE.has(action as ActionName)) {
    return { kind: "deny", reason: "personal data is not available in shared channels" };
  }

  switch (spec.kind) {
    case "read":
      return { kind: "allow", undoable: false };
    case "apply":
      if (spec.confirmWhenExternal && context.external) {
        return { kind: "confirm", reason: "it changes an externally synced appointment" };
      }
      return { kind: "allow", undoable: true };
    case "schedule":
      if (principal.initiator === "assistant" && context.intent !== "explicit") {
        return {
          kind: "deny",
          reason: "advice or a suggestion is not consent to change the schedule",
        };
      }
      return { kind: "allow", undoable: true };
    case "external":
      return { kind: "confirm", reason: "it changes an external appointment or recurring series" };
    case "destructive":
      return { kind: "confirm", reason: "it deletes or bulk-changes records" };
    case "escalate":
      return { kind: "consent", reason: "it expands what Epi may do" };
  }
}

// Gate for direct calls: throws unless the action may run right now without a confirmation.
export function authorize(
  principal: Pick<Principal, "audience" | "initiator">,
  action: ActionName,
  context: DecisionContext = {},
): Extract<Decision, { kind: "allow" }> {
  const decision = decide(principal, action, context);
  if (decision.kind === "allow") return decision;
  if (decision.kind === "deny") throw new AccessDeniedError(action, decision.reason);
  throw new ConfirmationRequiredError(action, decision.kind, decision.reason);
}
