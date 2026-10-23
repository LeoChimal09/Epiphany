// The rules of a live voice conversation, kept apart from Discord so they can be tested exactly:
// who may be acted on, when Epi is listening, and when it leaves. The audio plumbing (joining the
// channel, receiving per-speaker audio, playing replies) lives in the worker and calls into this.

export type SessionState = "idle" | "listening" | "stopped" | "left";

export type HearDecision =
  // The owner spoke while Epi is listening: treat the transcript like a typed message.
  | { action: "act" }
  // Someone else spoke, or Epi is not listening: the audio is dropped, nothing is acted on, and
  // nothing about the owner's records is said back.
  | { action: "ignore"; reason: "not_owner" | "not_listening" };

export type JoinDecision =
  { ok: true; announce: string } | { ok: false; reason: "not_owner" | "already_joined" };

export interface VoiceSession {
  readonly state: SessionState;
  readonly repliesMuted: boolean;
  // Epi joins only when the owner asks, and says out loud, in text, that it is listening.
  join(requesterId: string, channelName: string): JoinDecision;
  hear(speakerId: string): HearDecision;
  stopListening(requesterId: string): boolean;
  resumeListening(requesterId: string): boolean;
  muteReplies(requesterId: string, muted: boolean): boolean;
  leave(requesterId: string): boolean;
  // Called on a timer. Returns true when Epi should leave because nobody has spoken for too long.
  idleExpired(): boolean;
}

export function createVoiceSession(options: {
  ownerUserId: string;
  idleTimeoutMs: number;
  now?: () => number;
}): VoiceSession {
  const now = options.now ?? (() => Date.now());
  let state: SessionState = "idle";
  let muted = false;
  let lastActivity = now();

  const isOwner = (id: string) => id === options.ownerUserId;

  return {
    get state() {
      return state;
    },
    get repliesMuted() {
      return muted;
    },
    join(requesterId, channelName) {
      if (!isOwner(requesterId)) return { ok: false, reason: "not_owner" };
      if (state === "listening" || state === "stopped")
        return { ok: false, reason: "already_joined" };
      state = "listening";
      lastActivity = now();
      return {
        ok: true,
        announce: `I've joined ${channelName} and I'm listening. I only act on requests from you. Say "stop listening" to pause me, "mute your voice" to keep replies in text, or "leave" and I'll go.`,
      };
    },
    hear(speakerId) {
      if (state !== "listening") return { action: "ignore", reason: "not_listening" };
      if (!isOwner(speakerId)) return { action: "ignore", reason: "not_owner" };
      lastActivity = now();
      return { action: "act" };
    },
    stopListening(requesterId) {
      if (!isOwner(requesterId) || state !== "listening") return false;
      state = "stopped";
      lastActivity = now();
      return true;
    },
    resumeListening(requesterId) {
      if (!isOwner(requesterId) || state !== "stopped") return false;
      state = "listening";
      lastActivity = now();
      return true;
    },
    muteReplies(requesterId, value) {
      if (!isOwner(requesterId) || (state !== "listening" && state !== "stopped")) return false;
      muted = value;
      return true;
    },
    leave(requesterId) {
      if (!isOwner(requesterId) || (state !== "listening" && state !== "stopped")) return false;
      state = "left";
      return true;
    },
    idleExpired() {
      if (state !== "listening" && state !== "stopped") return false;
      if (now() - lastActivity < options.idleTimeoutMs) return false;
      state = "left";
      return true;
    },
  };
}
