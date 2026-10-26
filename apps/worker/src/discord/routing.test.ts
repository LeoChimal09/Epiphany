import { describe, expect, it } from "vitest";
import {
  fitDiscordMessage,
  routeMessage,
  splitDiscordMessage,
  stripEpiMention,
  type MessageFacts,
} from "./routing";

const owner = "100000000000000001";
const base: MessageFacts = {
  authorIsBot: false,
  authorId: owner,
  ownerId: owner,
  isDm: true,
  mentionsEpi: false,
};
const privateChannel = {
  isDm: false,
  channelName: "assistant",
  parentName: "epiphany",
  everyoneCanView: false,
};

describe("routing Discord messages", () => {
  it("answers the owner in a DM and in the unseen #assistant channel without a mention", () => {
    expect(routeMessage(base)).toEqual({ action: "handle", audience: "private" });
    expect(routeMessage({ ...base, ...privateChannel })).toEqual({
      action: "handle",
      audience: "private",
    });
    expect(routeMessage({ ...base, ...privateChannel, channelName: "check-ins" })).toEqual({
      action: "handle",
      audience: "private",
    });
  });

  it("never answers anyone but the owner, or another bot, anywhere", () => {
    for (const extra of [{ isDm: true }, privateChannel]) {
      expect(routeMessage({ ...base, ...extra, authorId: "200000000000000002" })).toEqual({
        action: "ignore",
      });
      expect(routeMessage({ ...base, ...extra, authorIsBot: true })).toEqual({ action: "ignore" });
    }
    expect(
      routeMessage({
        ...base,
        ...privateChannel,
        authorId: "200000000000000002",
        mentionsEpi: true,
      }),
    ).toEqual({ action: "ignore" });
  });

  it("ignores ordinary chatter in other channels but answers a mention as a shared audience", () => {
    const general = {
      isDm: false,
      channelName: "general",
      parentName: null,
      everyoneCanView: true,
    };
    expect(routeMessage({ ...base, ...general })).toEqual({ action: "ignore" });
    expect(routeMessage({ ...base, ...general, mentionsEpi: true })).toEqual({
      action: "handle",
      audience: "shared",
    });
  });

  it("treats a visible #assistant channel as shared, so personal data is refused there", () => {
    const visible = { ...privateChannel, everyoneCanView: true };
    expect(routeMessage({ ...base, ...visible })).toEqual({ action: "ignore" });
    expect(routeMessage({ ...base, ...visible, mentionsEpi: true })).toEqual({
      action: "handle",
      audience: "shared",
    });
  });
});

describe("message helpers", () => {
  it("delivers every character of a long review, including its approval instructions", () => {
    const text = `${Array.from({ length: 30 }, (_, i) => `${i + 1}. ${"assignment ".repeat(40)}`).join("\n")}\nReply yes to save these.`;
    const parts = splitDiscordMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length > 0 && part.length <= 2000)).toBe(true);
    expect(parts.join("")).toBe(text);
    expect(parts.at(-1)).toContain("Reply yes");
    expect(splitDiscordMessage("x".repeat(4001)).map((part) => part.length)).toEqual([
      2000, 2000, 1,
    ]);
    expect(splitDiscordMessage("short")).toEqual(["short"]);
  });

  it("shortens an over-long reply at a line break and says so", () => {
    const text = Array.from({ length: 300 }, (_, i) => `${i + 1}. a task title here`).join("\n");
    const fitted = fitDiscordMessage(text);
    expect(fitted.length).toBeLessThanOrEqual(2000);
    expect(fitted.endsWith("(shortened)")).toBe(true);
    expect(fitDiscordMessage("short")).toBe("short");
  });

  it("removes the mention of Epi but leaves other mentions", () => {
    expect(stripEpiMention("<@999> what's due? <@!999> <@123>", "999")).toBe("what's due?  <@123>");
  });
});
