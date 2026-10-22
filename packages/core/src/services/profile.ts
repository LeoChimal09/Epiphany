// Discord profile details shown in the dashboard. Values come from Discord's identify response,
// so they are validated before being stored or turned into a URL.

const AVATAR_HASH = /^(?:a_)?[0-9a-f]{32}$/;
const DISCORD_ID = /^\d{15,25}$/;
const MAX_NAME_LENGTH = 100;

export interface OwnerProfile {
  displayName: string;
  // A Discord CDN image, or null when the owner has no custom avatar (the dashboard then shows
  // its own placeholder).
  avatarUrl: string | null;
}

export function cleanAvatarHash(value: unknown): string | null {
  return typeof value === "string" && AVATAR_HASH.test(value) ? value : null;
}

// Collapses whitespace, drops control characters, and limits the length; falls back when empty.
export function cleanDisplayName(value: unknown, fallback = "Owner"): string {
  if (typeof value !== "string") return fallback;
  const name = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name ? name.slice(0, MAX_NAME_LENGTH) : fallback;
}

export function discordAvatarUrl(
  discordUserId: string | null,
  avatarHash: string | null,
  size = 128,
): string | null {
  if (!discordUserId || !DISCORD_ID.test(discordUserId)) return null;
  const hash = cleanAvatarHash(avatarHash);
  if (!hash) return null;
  return `https://cdn.discordapp.com/avatars/${discordUserId}/${hash}.png?size=${size}`;
}
