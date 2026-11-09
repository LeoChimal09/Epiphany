import { describe, expect, it, vi } from "vitest";
import type { Principal, Services } from "../services";
import { createBudget, createMemoryUsageStore } from "./budget";
import { createScriptedProvider } from "./provider";
import {
  cleanWellBeingQuestion,
  composeMorningGreeting,
  composeWellBeingQuestion,
  fallbackMorningGreeting,
  parseMorningGreeting,
} from "./well-being";

const principal = { ownerId: "fixture" } as Principal;
const now = new Date("2026-11-09T20:00:00Z");
const services = {
  tasks: {
    list: vi.fn(async () => [
      {
        id: "t1",
        title: "Finish essay",
        dueAt: new Date("2026-11-11T05:00:00Z"),
        taskType: "task",
        priority: "major",
      },
    ]),
  },
  notes: {
    list: vi.fn(async () => [
      { id: "n1", title: "Black Friday Shopping Idea", body: "", kind: "idea" },
    ]),
  },
  events: {
    list: vi.fn(async () => [
      {
        id: "e1",
        title: "Flight home",
        startsAt: new Date("2026-11-12T15:00:00Z"),
        endsAt: new Date("2026-11-12T18:00:00Z"),
        allDay: false,
      },
    ]),
  },
  preferences: {
    list: vi.fn(async () => [
      { key: "memory.walks", value: { text: "Likes evening walks" }, status: "confirmed" },
      { key: "memory.pending", value: { text: "Unconfirmed" }, status: "proposed" },
    ]),
  },
} as unknown as Services;
const budget = (limit = 5) =>
  createBudget(
    { monthlyLimitUsd: limit, warnPercent: 80, timezone: "America/Chicago" },
    createMemoryUsageStore(),
    () => now,
  );

describe("well-being questions written from the owner's records", () => {
  it("sends the owner's current records, records spending, and returns one clean question", async () => {
    const provider = createScriptedProvider(
      () => ({
        kind: "respond",
        text: '"With the essay due and a flight Thursday, what would make this week feel lighter?"',
      }),
      0.01,
    );
    const spend = budget();
    const question = await composeWellBeingQuestion({
      provider,
      budget: spend,
      services,
      principal,
      now,
      timezone: "America/Chicago",
      recentQuestions: ["How did the weekend go?"],
    });
    expect(question).toBe(
      "With the essay due and a flight Thursday, what would make this week feel lighter?",
    );
    const request = provider.calls[0]!;
    expect(request.openTasks[0]).toMatchObject({ title: "Finish essay", due: "2026-11-10" });
    expect(request.recentNotes[0]).toMatchObject({ title: "Black Friday Shopping Idea" });
    expect(request.events?.[0]).toMatchObject({ title: "Flight home" });
    expect(request.memories).toEqual(["Likes evening walks"]);
    expect(request.message).toContain('Recently asked: "How did the weekend go?"');
    expect((await spend.check()).spentUsd).toBeCloseTo(0.01);
  });

  it("returns null for actions, repeats, or when the budget is spent", async () => {
    const input = { services, principal, now, timezone: "America/Chicago" };
    expect(
      await composeWellBeingQuestion({
        ...input,
        budget: budget(),
        provider: createScriptedProvider(() => ({ kind: "list_tasks" }) as never),
      }),
    ).toBeNull();
    expect(
      await composeWellBeingQuestion({
        ...input,
        budget: budget(),
        recentQuestions: ["How is the week going?"],
        provider: createScriptedProvider(() => ({
          kind: "respond",
          text: "How is the week going?",
        })),
      }),
    ).toBeNull();
    const spent = budget(0.01);
    await spent.record(0.02);
    const unused = createScriptedProvider(() => ({ kind: "respond", text: "Unused?" }));
    expect(
      await composeWellBeingQuestion({ ...input, budget: spent, provider: unused }),
    ).toBeNull();
    expect(unused.calls).toHaveLength(0);
  });

  it("strips mentions and formatting and rejects non-questions", () => {
    expect(cleanWellBeingQuestion("@everyone **How** is <@123> your energy today?")).toBe(
      "How is your energy today?",
    );
    expect(cleanWellBeingQuestion("Have a great day.")).toBeNull();
  });
  it("writes a morning greeting that uses the chosen form of address", async () => {
    const provider = createScriptedProvider(
      () => ({ kind: "respond", text: "Good morning, sir. Ready for the essay push today?" }),
      0.01,
    );
    expect(
      await composeMorningGreeting({
        provider,
        budget: budget(),
        services,
        principal,
        now,
        timezone: "America/Chicago",
        address: "sir",
      }),
    ).toBe("Good morning, sir. Ready for the essay push today?");
    expect(provider.calls[0]!.message).toContain('Address the owner as "sir"');
    expect(fallbackMorningGreeting("sir")).toBe("Good morning, sir. How are we doing today?");
    expect(parseMorningGreeting({ enabled: true, address: " " })).toEqual({
      enabled: true,
      address: null,
    });
  });
});
