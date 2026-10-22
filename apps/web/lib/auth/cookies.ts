import { timingSafeEqual } from "node:crypto";

// __Host- cookies must be Secure, Path=/, and have no Domain, so they cannot be set by a
// sibling subdomain. They need HTTPS, so local http development uses plain names.
export function cookieNames(secure: boolean) {
  const prefix = secure ? "__Host-" : "";
  return {
    session: `${prefix}epiphany_session`,
    oauth: `${prefix}epiphany_oauth`,
    googleOauth: `${prefix}epiphany_google_oauth`,
  };
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function setCookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAgeSeconds?: number; expires?: Date },
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return setCookie(name, "", { secure, maxAgeSeconds: 0, expires: new Date(0) });
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
