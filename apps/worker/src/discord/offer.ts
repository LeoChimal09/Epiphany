import { workspaceCreatedMessage, workspaceOffer, workspaceProblemMessage } from "./routing";
import type { WorkspaceApplyResult } from "./workspace";

// What an offer needs from Discord, so the decision can be tested without it.
export interface OfferPort {
  ownerIsMember(): Promise<boolean>;
  // How many workspace resources (the category and its channels) are still missing.
  missingResources(): Promise<number>;
  alreadyOffered(): Promise<boolean>;
  sendOffer(text: string): Promise<void>;
}

export type OfferResult =
  "offered" | "already_offered" | "already_set_up" | "not_member" | "dm_failed";

// Tells the owner, once per server, that Epi is there and can set up the workspace. Nothing is
// created: setup still waits for the owner to ask. Servers the owner is not in are ignored, so a
// stranger adding Epi to their server causes nothing to be sent or created.
export async function offerWorkspace(port: OfferPort, serverName: string): Promise<OfferResult> {
  if (!(await port.ownerIsMember())) return "not_member";
  if ((await port.missingResources()) === 0) return "already_set_up";
  if (await port.alreadyOffered()) return "already_offered";
  try {
    await port.sendOffer(workspaceOffer(serverName));
    return "offered";
  } catch {
    return "dm_failed";
  }
}

// What automatic setup needs from Discord.
export interface SetupPort {
  ownerIsMember(): Promise<boolean>;
  // Whether the owner owns the server. Only then is inviting Epi taken as approval to set up.
  ownerOwnsServer(): boolean;
  apply(): Promise<WorkspaceApplyResult>;
  // Whether the owner was already told about a problem in this server.
  alreadyToldAboutProblem(): Promise<boolean>;
  sendDm(text: string): Promise<void>;
}

export type SetupOutcome =
  | "created"
  | "already_set_up"
  | "problem_reported"
  | "problem_known"
  | "not_member"
  | "not_owner"
  | "dm_failed";

// In a server the owner owns, adding Epi is the approval: create the private workspace, once, and
// tell the owner by DM what happened. Anywhere else the caller falls back to an offer. Setup is
// idempotent, so running at every start only acts when something is missing; a problem is reported
// once rather than at every restart.
export async function autoSetupWorkspace(
  port: SetupPort,
  serverName: string,
): Promise<SetupOutcome> {
  if (!(await port.ownerIsMember())) return "not_member";
  if (!port.ownerOwnsServer()) return "not_owner";

  const result = await port.apply();
  const made = result.created.length > 0 || result.categoryCreated;
  if (!result.problem && !made) return "already_set_up";

  if (result.problem) {
    if (await port.alreadyToldAboutProblem()) return "problem_known";
  }
  const text = result.problem
    ? workspaceProblemMessage(serverName, result.created, result.problem)
    : workspaceCreatedMessage(serverName, result.created);
  try {
    await port.sendDm(text);
  } catch {
    return "dm_failed";
  }
  return result.problem ? "problem_reported" : "created";
}
