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
