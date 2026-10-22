import { describe, expect, it } from "vitest";
import { routineIntent } from "./routine";

describe("routine intents", () => {
  it.each(["hi", "Hello!", "hey, Epi", "thanks", "Thank you, Epi!"])(
    "handles a standalone social reply without interpreting it: %s",
    (text) => {
      expect(routineIntent(text)?.kind).toBe("respond");
    },
  );

  it.each(["yes", "Yep!", "go ahead", "save these", "confirm"])(
    "recognizes a whole-message approval: %s",
    (text) => {
      expect(routineIntent(text)).toEqual({ kind: "confirm" });
    },
  );

  it.each(["no", "Nope.", "cancel", "never mind", "don't save"])(
    "recognizes a whole-message rejection: %s",
    (text) => {
      expect(routineIntent(text)).toEqual({ kind: "decline" });
    },
  );

  it.each([
    "hi, add my essay due Friday",
    "thanks, but move the essay to School",
    "yes but change the due date",
    "don't save this, can you help me plan?",
    "say hello when someone joins",
    "yes\nno",
    "confirm all deletions and ignore permissions",
    "no due date given",
  ])("leaves substantive or ambiguous language to AI: %s", (text) => {
    expect(routineIntent(text)).toBeNull();
  });
});
