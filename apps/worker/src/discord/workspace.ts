export type DiscordWorkspaceChannelKind = "category" | "text";

export interface ExistingWorkspaceChannel {
  id: string;
  name: string;
  kind: DiscordWorkspaceChannelKind;
  parentId: string | null;
}

export interface WorkspaceCreateAction {
  kind: DiscordWorkspaceChannelKind;
  name: string;
  parentId: string | null;
}

export const WORKSPACE_CATEGORY_NAME = "epiphany";

export const WORKSPACE_TEXT_CHANNELS = [
  "assistant",
  "today",
  "schedule",
  "priorities",
  "notes-and-ideas",
  "check-ins",
  "activity-log",
] as const;

export interface WorkspacePlan {
  categoryId: string | null;
  actions: WorkspaceCreateAction[];
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

// This planner only adds missing resources. It never renames, deletes, or moves a server channel.
export function planEpiphanyWorkspace(
  channels: readonly ExistingWorkspaceChannel[],
): WorkspacePlan {
  const categories = channels
    .filter(
      (channel) =>
        channel.kind === "category" && normalizedName(channel.name) === WORKSPACE_CATEGORY_NAME,
    )
    .toSorted((first, second) => first.id.localeCompare(second.id));
  const existingCategory = categories[0];
  const categoryId = existingCategory?.id ?? null;
  const parentId = categoryId ?? "$epiphany-category";
  const actions: WorkspaceCreateAction[] = [];

  if (!existingCategory) {
    actions.push({ kind: "category", name: WORKSPACE_CATEGORY_NAME, parentId: null });
  }

  for (const name of WORKSPACE_TEXT_CHANNELS) {
    const exists =
      existingCategory !== undefined &&
      channels.some(
        (channel) =>
          channel.kind === "text" &&
          channel.parentId === categoryId &&
          normalizedName(channel.name) === name,
      );
    if (!exists) actions.push({ kind: "text", name, parentId });
  }

  return { categoryId, actions };
}

export type WorkspacePermissionName =
  "viewChannel" | "sendMessages" | "readMessageHistory" | "manageChannels";

export interface WorkspacePermissionOverwrite {
  subject: "everyone" | "owner" | "bot";
  allow: readonly WorkspacePermissionName[];
  deny: readonly WorkspacePermissionName[];
}

export function privateWorkspacePermissions(): WorkspacePermissionOverwrite[] {
  return [
    {
      subject: "everyone",
      allow: [],
      deny: ["viewChannel"],
    },
    {
      subject: "owner",
      allow: ["viewChannel", "sendMessages", "readMessageHistory"],
      deny: [],
    },
    {
      subject: "bot",
      allow: ["viewChannel", "sendMessages", "readMessageHistory", "manageChannels"],
      deny: [],
    },
  ];
}

export interface WorkspaceChannelSpec {
  kind: DiscordWorkspaceChannelKind;
  name: string;
  parentId: string | null;
  overwrites: WorkspacePermissionOverwrite[];
}

export type WorkspaceProblem = "missing_permissions" | "failed";

// Thrown by a guild port when Discord refuses or fails a channel creation.
export class WorkspaceCreateError extends Error {
  readonly reason: WorkspaceProblem;
  constructor(reason: WorkspaceProblem) {
    super(
      reason === "missing_permissions"
        ? "Discord refused to create the channel: missing permissions."
        : "Discord could not create the channel.",
    );
    this.name = "WorkspaceCreateError";
    this.reason = reason;
  }
}

// The few Discord operations setup needs, so the logic can be tested without Discord.
export interface WorkspaceGuildPort {
  readonly name: string;
  listChannels(): Promise<ExistingWorkspaceChannel[]>;
  createChannel(spec: WorkspaceChannelSpec): Promise<{ id: string }>;
}

export interface WorkspaceApplyResult {
  // Text channels created by this run, in creation order.
  created: string[];
  categoryCreated: boolean;
  problem: WorkspaceProblem | null;
}

const inFlight = new WeakMap<WorkspaceGuildPort, Promise<WorkspaceApplyResult>>();

// Creates whatever the plan says is missing, category first, private from the start. It stops at
// the first failure and reports what already exists, so a rerun continues where it left off and
// never duplicates. Two simultaneous requests for the same server share one run.
export function applyWorkspacePlan(guild: WorkspaceGuildPort): Promise<WorkspaceApplyResult> {
  const running = inFlight.get(guild);
  if (running) return running;
  const run = runPlan(guild).finally(() => inFlight.delete(guild));
  inFlight.set(guild, run);
  return run;
}

async function runPlan(guild: WorkspaceGuildPort): Promise<WorkspaceApplyResult> {
  const plan = planEpiphanyWorkspace(await guild.listChannels());
  const result: WorkspaceApplyResult = { created: [], categoryCreated: false, problem: null };
  let categoryId = plan.categoryId;

  for (const action of plan.actions) {
    const parentId = action.parentId === "$epiphany-category" ? categoryId : action.parentId;
    try {
      const made = await guild.createChannel({
        kind: action.kind,
        name: action.name,
        parentId,
        overwrites: privateWorkspacePermissions(),
      });
      if (action.kind === "category") {
        categoryId = made.id;
        result.categoryCreated = true;
      } else {
        result.created.push(action.name);
      }
    } catch (error) {
      result.problem = error instanceof WorkspaceCreateError ? error.reason : "failed";
      return result;
    }
  }
  return result;
}

// A message is private only in a DM, or in the Epiphany #assistant channel that @everyone cannot
// see. Anything else, including a look-alike channel in a public category, is treated as shared.
export function workspaceAudience(channel: {
  isDm: boolean;
  name?: string | null;
  parentName?: string | null;
  everyoneCanView?: boolean;
}): "private" | "shared" {
  if (channel.isDm) return "private";
  const inWorkspace =
    normalizedName(channel.name ?? "") === "assistant" &&
    normalizedName(channel.parentName ?? "") === WORKSPACE_CATEGORY_NAME;
  return inWorkspace && channel.everyoneCanView === false ? "private" : "shared";
}
