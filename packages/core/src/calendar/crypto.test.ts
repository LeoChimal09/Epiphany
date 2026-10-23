import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, tokenContext, TokenCryptoError } from "./crypto";

const key = randomBytes(32);
const context = tokenContext("account-1", "refresh");

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips and never stores the plaintext", () => {
    const secret = "synthetic-refresh-token-value";
    const encrypted = encryptToken(key, context, secret);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(decryptToken(key, context, encrypted)).toBe(secret);
  });

  it("uses a fresh nonce each time", () => {
    expect(encryptToken(key, context, "same")).not.toBe(encryptToken(key, context, "same"));
  });

  it("detects tampering with any part", () => {
    const parts = encryptToken(key, context, "synthetic").split(".");
    for (const index of [1, 2, 3]) {
      const copy = [...parts];
      const bytes = Buffer.from(copy[index]!, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      copy[index] = bytes.toString("base64url");
      expect(() => decryptToken(key, context, copy.join("."))).toThrow(TokenCryptoError);
    }
  });

  it("rejects the wrong key and a different binding context", () => {
    const encrypted = encryptToken(key, context, "synthetic");
    expect(() => decryptToken(randomBytes(32), context, encrypted)).toThrow(TokenCryptoError);
    expect(() => decryptToken(key, tokenContext("account-2", "refresh"), encrypted)).toThrow(
      TokenCryptoError,
    );
    expect(() => decryptToken(key, tokenContext("account-1", "access"), encrypted)).toThrow(
      TokenCryptoError,
    );
  });

  it("rejects malformed input and bad keys without echoing the token", () => {
    expect(() => decryptToken(key, context, "not-encrypted")).toThrow(TokenCryptoError);
    expect(() => encryptToken(randomBytes(16), context, "x")).toThrow(/32 bytes/);
    try {
      decryptToken(key, context, "v1.AAAA.BBBB.CCCC");
    } catch (error) {
      expect((error as Error).message).not.toContain("CCCC");
    }
  });
});
