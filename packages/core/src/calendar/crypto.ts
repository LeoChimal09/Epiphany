import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Calendar OAuth tokens are stored only as AES-256-GCM ciphertext. The format is
// `v1.<iv>.<tag>.<ciphertext>` (base64url). `context` (the account ID and token kind) is bound in
// as additional authenticated data, so a ciphertext copied to another row or swapped between the
// access and refresh token fails to decrypt instead of being accepted.
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

function checkKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TokenCryptoError("The token encryption key must be exactly 32 bytes.");
  }
}

export function encryptToken(key: Buffer, context: string, plaintext: string): string {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

// Throws TokenCryptoError for a wrong key, altered ciphertext, or a different context. The message
// never contains the token or the key.
export function decryptToken(key: Buffer, context: string, encrypted: string): string {
  checkKey(key);
  const parts = encrypted.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenCryptoError("The stored token is not in a recognized format.");
  }
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("bad lengths");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TokenCryptoError(
      "The stored token could not be decrypted (wrong key or altered data).",
    );
  }
}

export const tokenContext = (accountId: string, kind: "access" | "refresh") =>
  `calendar-account:${accountId}:${kind}`;
