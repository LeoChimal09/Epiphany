import { describe, expect, it } from "vitest";
import { IntentError, intentJsonSchema, toIntent } from "./intent";

const wire = (over: Record<string, unknown>) => ({
  kind: "respond",
  text: null,
  title: null,
  details: null,
  due_date: null,
  due_time: null,
  estimated_minutes: null,
  note_kind: null,
  status: null,
  from_date: null,
  through_date: null,
  search: null,
  reference: null,
  target_id: null,
  ...over,
});

describe("intent parsing", () => {
  it("parses each kind into a typed intent and drops unused fields", () => {
    expect(toIntent(wire({ kind: "respond", text: "Try the lab first." }))).toEqual({
      kind: "respond",
      text: "Try the lab first.",
    });
    expect(toIntent(wire({ kind: "clarify", text: "Which essay?" }))).toEqual({
      kind: "clarify",
      question: "Which essay?",
    });
    expect(
      toIntent(
        wire({
          kind: "list_tasks",
          status: "open",
          from_date: "2026-10-12",
          through_date: "2026-10-18",
        }),
      ),
    ).toEqual({
      kind: "list_tasks",
      status: "open",
      dueFrom: "2026-10-12",
      dueThrough: "2026-10-18",
    });
    expect(toIntent(wire({ kind: "list_tasks" }))).toEqual({ kind: "list_tasks", status: "open" });
    expect(
      toIntent(
        wire({
          kind: "create_note",
          title: "Workout app",
          details: "Track workouts against free time.",
          note_kind: "idea",
        }),
      ),
    ).toEqual({
      kind: "create_note",
      title: "Workout app",
      body: "Track workouts against free time.",
      noteKind: "idea",
    });
    expect(
      toIntent(
        wire({
          kind: "create_task",
          title: "  Read chapter 4 ",
          due_date: "2026-10-16",
          due_time: "17:00",
          estimated_minutes: 45,
        }),
      ),
    ).toEqual({
      kind: "create_task",
      title: "Read chapter 4",
      dueDate: "2026-10-16",
      dueTime: "17:00",
      estimatedMinutes: 45,
    });
    expect(
      toIntent(wire({ kind: "complete_task", reference: "chem lab", target_id: "abc" })),
    ).toEqual({
      kind: "complete_task",
      reference: "chem lab",
      targetId: "abc",
    });
    expect(toIntent(wire({ kind: "confirm" }))).toEqual({ kind: "confirm" });
    expect(toIntent(wire({ kind: "decline" }))).toEqual({ kind: "decline" });
  });

  it("rejects output that does not fit the contract", () => {
    const bad: unknown[] = [
      null,
      "complete everything",
      wire({ kind: "drop_database" }),
      wire({ kind: "respond", text: null }),
      wire({ kind: "create_task", title: "  " }),
      wire({ kind: "create_task", title: "x", due_date: "2026-02-30" }),
      wire({ kind: "create_task", title: "x", due_time: "17:00" }),
      wire({ kind: "create_task", title: "x", due_date: "2026-10-16", due_time: "5pm" }),
      wire({ kind: "list_tasks", from_date: "2026-10-18", through_date: "2026-10-12" }),
      wire({ kind: "create_task", title: "x", estimated_minutes: 0 }),
      { ...wire({ kind: "respond", text: "hi" }), sql: "DROP TABLE tasks" },
    ];
    for (const value of bad) expect(() => toIntent(value)).toThrow(IntentError);
  });

  it("publishes a strict JSON schema with every field required and no extras", () => {
    const schema = intentJsonSchema() as {
      $schema?: string;
      additionalProperties: boolean;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.toSorted()).toEqual(Object.keys(schema.properties).toSorted());
  });
});
