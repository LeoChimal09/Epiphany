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
      onOpenItem: () => {},
    }),
  );
}

describe("assistant review messages", () => {
  it("shows saved-session controls and blocks sending into a restored in-flight turn", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantChat, {
        setup: "ready",
        messages: [],
        asking: false,
        budgetNote: null,
        voice: { listen: false, speak: false },
        timezone: "America/Chicago",
        topic: { label: "note", title: "Gift list" },
        sessions: [{ id: "saved", title: "Gift list", updatedAt: "2026-11-09T15:00:00Z" }],
        sessionId: "saved",
        sessionBusy: true,
        onNewSession: () => {},
        onSwitchSession: () => {},
        onReloadSession: () => {},
        onDeleteSession: () => {},
        onClearTopic: () => {},
        onSend: () => {},
        onOpenItem: () => {},
      }),
    );
    expect(html).toContain("Talking about note");
    expect(html).toContain("New conversation");
    expect(html).toContain("Reload conversation");
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Delete conversation"/);
    expect(html).toContain("90 days");
    expect(html).toContain("request is in progress");
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).not.toContain("Epi&#x27;s language model is not connected");
  });
  it.each(["note", "idea"])("offers an exact saved %s link in the existing dashboard", (kind) => {
    const html = render({
      id: 1,
      role: "epi",
      text: "Saved.",
      outcome: "created",
      changed: true,
      links: [{ label: `Open ${kind}: Garden plan`, href: "#note-saved" }],
    });
    expect(html).toContain('href="#note-saved"');
    expect(html).toContain(`Open ${kind}: Garden plan`);
    expect(html).not.toContain('target="_blank"');
  });
  it("links a verified creation to its exact saved record without replacing the chat", () => {
    const html = render({
      id: 1,
      role: "epi",
      text: 'Added "Cleaning room".',
      outcome: "created",
      changed: true,
      links: [{ label: "Open task: Cleaning room", href: "#task-saved-task" }],
    });
    expect(html).toContain('href="#task-saved-task"');
    expect(html).not.toContain('target="_blank"');
    expect(html).toContain("Open task: Cleaning room");
  });
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

  it("shows the selected topic and a way to leave it", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantChat, {
        setup: "ready",
        messages: [],
        asking: false,
        budgetNote: null,
        voice: { listen: false, speak: false },
        timezone: "America/Chicago",
        topic: { label: "idea", title: "Garden plan" },
        onClearTopic: () => {},
        onSend: () => {},
        onOpenItem: () => {},
      }),
    );
    expect(html).toContain("Talking about idea");
    expect(html).toContain("Garden plan");
    expect(html).toContain("Clear topic");
  });
});
