import { describe, expect, it } from "vitest";
import { INTENT_KINDS, IntentError } from "./intent";
import { ACTION_TOOLS, toolToIntent } from "./tools";

const examples = {
  website_link: {},
  list_tasks: { status: "completed", search: "library" },
  create_task: { title: "Return drill", due_date: "2026-10-23", due_time: "17:00" },
  create_event: {
    title: "Study group",
    event_date: "2026-10-23",
    start_time: "16:30",
    end_time: "17:00",
  },
  create_note: { details: "A neighborhood tool library", note_kind: "idea" },
  develop_idea: { details: "Concern: Tracking returns", reference: "Tool library" },
  resume_idea: { reference: "Tool library" },
  capture: { items: [{ type: "idea", title: "Tool library", details: "Share tools" }] },
  recategorize: { target_id: "task-1", category: "Home" },
  complete_task: { target_id: "task-1" },
  update_task: { reference: "Return drill", task_type: "task", due_date: "2026-10-24" },
  reopen_task: { reference: "Return drill" },
  acknowledge_event: { reference: "Study group" },
  delete_note: { reference: "Tool library" },
  setup_workspace: {},
  snooze: {},
  skip_event: {},
  pause_reminders: {},
  resume_reminders: {},
  start_activity: { title: "Gardening", estimated_minutes: 60 },
  create_reminder: { title: "Go grocery shopping", due_date: "2026-10-26", due_time: "14:00" },
  voice_control: { search: "join" },
  report_duration: { reference: "Return drill", estimated_minutes: 20 },
  show_insights: {},
  correct_estimate: { title: "Garden work", estimated_minutes: 60 },
  forget_insights: {},
  set_preference: { search: "tracking.enabled", details: "true" },
  show_schedule: { from_date: "2026-10-22", through_date: "2026-10-23" },
  plan_work: { reference: "Return drill", due_date: "2026-10-23", due_time: "17:00" },
  remember: { details: "I prefer borrowing tools", explicit: true },
  list_memory: {},
  forget: { reference: "borrowing tools" },
  undo: {},
  confirm: {},
  decline: {},
};

describe("minimal action tools", () => {
  it("retains every existing action capability", () => {
    const names = INTENT_KINDS.filter((kind) => !["respond", "clarify"].includes(kind)).sort();
    expect(Object.keys(examples).sort()).toEqual(names);
    expect(ACTION_TOOLS.map((entry) => entry.function.name).sort()).toEqual(names);
  });

  it.each(Object.entries(examples))(
    "validates sparse %s arguments through the existing contract",
    (name, args) => {
      expect(toolToIntent(name, args).kind).toBe(name);
    },
  );

  it("rejects text/envelope/authority fields that are not action arguments", () => {
    for (const args of [
      { details: "Tool library", text: "Saved!" },
      { details: "Tool library", kind: "confirm" },
      { details: "Tool library", ownerId: "another-owner" },
    ]) {
      expect(() => toolToIntent("create_note", args)).toThrow(IntentError);
    }
  });

  it("preserves idea feedback without requiring duplicate text in tool arguments", () => {
    expect(toolToIntent("create_note", examples.create_note, "How would returns work?")).toEqual({
      kind: "create_note",
      body: "A neighborhood tool library",
      noteKind: "idea",
      feedback: "How would returns work?",
    });
  });
});
