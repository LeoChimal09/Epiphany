import { workspaceAudience } from "./workspace";

export interface MessageFacts {
  authorIsBot: boolean;
  authorId: string;
  ownerId: string;
  isDm: boolean;
  channelName?: string | null;
  parentName?: string | null;
  everyoneCanView?: boolean;
  mentionsEpi: boolean;
}

export type Route =
  // Not for Epi: other people, bots, and chatter in channels Epi was not addressed in.
  { action: "ignore" } | { action: "handle"; audience: "private" | "shared" };

// Only the owner is ever answered. In a DM or the unseen Epiphany #assistant/#check-ins channels
// every message is for Epi; anywhere else Epi only answers when mentioned, as a shared audience.
export function routeMessage(facts: MessageFacts): Route {
  if (facts.authorIsBot || facts.authorId !== facts.ownerId) return { action: "ignore" };
  const audience = workspaceAudience({
    isDm: facts.isDm,
    name: facts.channelName,
    parentName: facts.parentName,
    ...(facts.everyoneCanView === undefined ? {} : { everyoneCanView: facts.everyoneCanView }),
  });
  if (audience === "private") return { action: "handle", audience };
  return facts.mentionsEpi ? { action: "handle", audience } : { action: "ignore" };
}

const DISCORD_LIMIT = 2000;

// Discord rejects messages over 2000 characters; cut at a line or word so a long task list still
// sends, and say so.
export function fitDiscordMessage(text: string): string {
  if (text.length <= DISCORD_LIMIT) return text;
  const note = "\n...(shortened)";
  const head = text.slice(0, DISCORD_LIMIT - note.length);
  const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
  return `${head.slice(0, cut > DISCORD_LIMIT / 2 ? cut : head.length)}${note}`;
}

// Reviews must arrive in full: a shortened preview could hide items the owner is approving.
export function splitDiscordMessage(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_LIMIT) {
    const head = remaining.slice(0, DISCORD_LIMIT);
    const line = head.lastIndexOf("\n");
    const cut = line > 0 ? line + 1 : DISCORD_LIMIT;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function stripEpiMention(content: string, epiUserId: string): string {
  return content.replace(new RegExp(`<@!?${epiUserId}>`, "g"), "").trim();
}

// Said when the owner mentions Epi somewhere other people could read. No model call, no records.
export const SHARED_CHANNEL_REPLY =
  "I keep your tasks private, so I only talk about them in a DM with me or in your private #assistant/#check-ins channels. Send me a DM and tell me you'd like your workspace set up, and I'll create it in this server.";

// The one-time DM that tells the owner Epi joined a server and what happens next.
export function workspaceOffer(serverName: string): string {
  return `Hi, it's Epi. I'm now in your server "${serverName}". I can create a private "epiphany" category there that only you and I can see, with channels for today, your schedule, priorities, and notes. Just tell me here, in your own words, when you'd like me to set it up.`;
}

// DM sent after Epi sets up a server the owner owns on its own.
export function workspaceCreatedMessage(serverName: string, created: readonly string[]): string {
  const list = created.map((name) => `#${name}`).join(", ");
  return `Hi, it's Epi. I set up your private workspace in "${serverName}" (${list || "it was already mostly there"}). Only you and I can see it. You can talk to me in #assistant or #check-ins, or right here in this DM.`;
}

// DM sent when automatic setup stopped. Says what Epi needs, never anything it did not do.
export function workspaceProblemMessage(
  serverName: string,
  created: readonly string[],
  reason: "missing_permissions" | "failed",
): string {
  const made =
    created.length > 0 ? ` I had already created ${created.map((n) => `#${n}`).join(", ")}.` : "";
  const why =
    reason === "missing_permissions"
      ? "I'm missing a permission there. I need Manage Channels, View Channels, Send Messages, and Read Message History (not Administrator). Fix that in the server's role settings for my role, then restart me or ask me here to set it up."
      : "Discord returned an error. I'll try again next time I start, or you can ask me here to set it up.";
  return `Hi, it's Epi. I tried to set up your workspace in "${serverName}" but couldn't finish.${made} ${why}`;
}
