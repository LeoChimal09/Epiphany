import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AssistantChat, type ChatMessage } from "./assistant-chat";

// The voice controls call server actions, which cannot run in a render test.
vi.mock("./voice-actions", () => ({
  speakReplyAloud: async () => ({ ok: false }),
  transcribeMicrophone: async () => ({ ok: false, error: "" }),
}));

function render(message: ChatMessage) {
  return renderToStaticMarkup(
    createElement(AssistantChat, {
      setup: "ready",
      messages: [message],
      asking: false,
      budgetNote: null,
      voice: { listen: false, speak: false },
      timezone: "America/Chicago",
      onSend: () => {},
    }),
  );
}

describe("assistant review messages", () => {
  it("offers approval and cancellation for an unsaved import preview", () => {
    const html = render({
      id: 1,
      role: "epi",
      text: "I found two items. Nothing is saved yet.",
      outcome: "confirmation_needed",
      changed: false,
    });
    expect(html).toContain("Yes, confirm");
    expect(html).toContain("No, cancel");
    expect(html).not.toContain("No, keep it");
    expect(html).not.toContain("> Saved");
  });

  it("warns about an unverified save without claiming nothing changed", () => {
    const html = render({
      id: 1,
      role: "epi",
      text: "I couldn't verify whether the assignment was saved.",
      outcome: "uncertain",
      changed: false,
    });
    expect(html).toContain("Check saved items before retrying");
    expect(html).not.toContain("Nothing was changed");
    expect(html).not.toContain("> Saved");
  });
});
