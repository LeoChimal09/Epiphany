import { describe, expect, it } from "vitest";
import { createVoiceSession } from "./session";

const OWNER = "100000000000000001";
const OTHER = "200000000000000002";

function session(idleTimeoutMs = 5 * 60_000) {
  let time = 1_000_000;
  const s = createVoiceSession({ ownerUserId: OWNER, idleTimeoutMs, now: () => time });
  return { s, advance: (ms: number) => (time += ms) };
}

describe("live voice session rules", () => {
  it("joins only for the owner, and announces that it is listening and how to stop it", () => {
    const { s } = session();
    expect(s.join(OTHER, "Voice")).toEqual({ ok: false, reason: "not_owner" });
    expect(s.state).toBe("idle");
    const joined = s.join(OWNER, "Study Room");
    expect(joined).toMatchObject({ ok: true });
    expect(joined.ok && joined.announce).toContain("I'm listening");
    expect(joined.ok && joined.announce).toContain("only act on requests from you");
    expect(s.join(OWNER, "Study Room")).toEqual({ ok: false, reason: "already_joined" });
  });

  it("acts only on the owner's speech while listening, and drops everyone else", () => {
    const { s } = session();
    expect(s.hear(OWNER)).toEqual({ action: "ignore", reason: "not_listening" });
    s.join(OWNER, "Room");
    expect(s.hear(OWNER)).toEqual({ action: "act" });
    expect(s.hear(OTHER)).toEqual({ action: "ignore", reason: "not_owner" });
  });

  it("honors stop listening, resume, mute, and leave, only from the owner", () => {
    const { s } = session();
    s.join(OWNER, "Room");
    expect(s.stopListening(OTHER)).toBe(false);
    expect(s.stopListening(OWNER)).toBe(true);
    expect(s.hear(OWNER)).toEqual({ action: "ignore", reason: "not_listening" });
    expect(s.resumeListening(OWNER)).toBe(true);
    expect(s.hear(OWNER)).toEqual({ action: "act" });
    expect(s.muteReplies(OWNER, true)).toBe(true);
    expect(s.repliesMuted).toBe(true);
    expect(s.muteReplies(OTHER, false)).toBe(false);
    expect(s.leave(OTHER)).toBe(false);
    expect(s.leave(OWNER)).toBe(true);
    expect(s.state).toBe("left");
    expect(s.hear(OWNER)).toEqual({ action: "ignore", reason: "not_listening" });
  });

  it("leaves by itself after the idle timeout, and the owner speaking keeps it there", () => {
    const { s, advance } = session(60_000);
    s.join(OWNER, "Room");
    advance(50_000);
    expect(s.idleExpired()).toBe(false);
    s.hear(OWNER);
    advance(50_000);
    expect(s.idleExpired()).toBe(false);
    s.hear(OTHER);
    advance(20_000);
    // Someone else talking does not keep it alive.
    expect(s.idleExpired()).toBe(true);
    expect(s.state).toBe("left");
    expect(s.idleExpired()).toBe(false);
  });
});
