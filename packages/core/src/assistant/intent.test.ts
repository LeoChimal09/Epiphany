import { describe, expect, it } from "vitest";
import { IntentError, intentJsonSchema, MAX_CAPTURE_ITEMS, toIntent } from "./intent";

const wire = (over: Record<string, unknown>) => ({
  kind: "respond",
  text: null,
  title: null,
  details: null,
  due_date: null,
  due_time: null,
  estimated_minutes: null,
  priority: null,
  note_kind: null,
  status: null,
  from_date: null,
  through_date: null,
  search: null,
  reference: null,
  target_id: null,
  category: null,
  explicit: null,
  items: null,
  ...over,
});

describe("intent parsing", () => {
  it("resumes an idea without requiring new points or saving anything", () => {
    expect(
      toIntent(wire({ kind: "resume_idea", reference: "tool library", details: null })),
    ).toEqual({ kind: "resume_idea", reference: "tool library" });
  });

  it("keeps idea feedback and parses bounded appended bullet points without a new wire schema", () => {
    expect(
      toIntent(
        wire({
          kind: "create_note",
          title: "Neighborhood tool library",
          details: "Neighbors can lend tools.",
          note_kind: "idea",
          text: "Start with one neighborhood. How would you track returns?",
        }),
      ),
    ).toMatchObject({
      kind: "create_note",
      noteKind: "idea",
      feedback: "Start with one neighborhood. How would you track returns?",
    });
    expect(
      toIntent(
        wire({
          kind: "develop_idea",
          reference: "this idea",
          target_id: "idea-1",
          details: "- Track return dates\n- Suggestion: start with a small trusted group",
          text: "A return date would help. Would reminders be optional?",
        }),
      ),
    ).toEqual({
      kind: "develop_idea",
      reference: "this idea",
      targetId: "idea-1",
      points: ["Track return dates", "Suggestion: start with a small trusted group"],
      feedback: "A return date would help. Would reminders be optional?",
    });
    for (const details of [null, "", "x".repeat(501), Array(13).fill("point").join("\n")]) {
      expect(() => toIntent(wire({ kind: "develop_idea", details }))).toThrow(IntentError);
    }
  });

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
          priority: "major",
        }),
      ),
    ).toEqual({
      kind: "create_task",
      title: "Read chapter 4",
      dueDate: "2026-10-16",
      dueTime: "17:00",
      estimatedMinutes: 45,
      priority: "major",
    });
    expect(toIntent(wire({ kind: "create_task", title: "Exam next month" }))).toEqual({
      kind: "create_task",
      title: "Exam next month",
    });
    expect(
      toIntent(
        wire({
          kind: "create_reminder",
          title: "Go grocery shopping",
          due_date: "2026-10-26",
          due_time: "14:00",
        }),
      ),
    ).toEqual({
      kind: "create_reminder",
      title: "Go grocery shopping",
      date: "2026-10-26",
      time: "14:00",
    });
    for (const invalid of [
      wire({ kind: "create_reminder", title: "Groceries", due_date: null, due_time: "14:00" }),
      wire({
        kind: "create_reminder",
        title: "Groceries",
        due_date: "2026-10-26",
        due_time: "2pm",
      }),
    ]) {
      expect(() => toIntent(invalid)).toThrow(IntentError);
    }
    expect(
      toIntent(wire({ kind: "complete_task", reference: "chem lab", target_id: "abc" })),
    ).toEqual({
      kind: "complete_task",
      reference: "chem lab",
      targetId: "abc",
    });
    expect(toIntent(wire({ kind: "confirm" }))).toEqual({ kind: "confirm" });
    expect(toIntent(wire({ kind: "decline" }))).toEqual({ kind: "decline" });
    expect(toIntent(wire({ kind: "setup_workspace", reference: " My Server " }))).toEqual({
      kind: "setup_workspace",
      server: "My Server",
    });
    expect(toIntent(wire({ kind: "setup_workspace" }))).toEqual({ kind: "setup_workspace" });
    expect(toIntent(wire({ kind: "undo" }))).toEqual({ kind: "undo" });
    expect(
      toIntent(
        wire({
          kind: "set_preference",
          search: "reminders.quiet_hours",
          details: '{"start":"22:00","end":"07:00"}',
          title: "quiet hours",
        }),
      ),
    ).toEqual({
      kind: "set_preference",
      key: "reminders.quiet_hours",
      value: { start: "22:00", end: "07:00" },
      summary: "quiet hours",
    });
    expect(
      toIntent(
        wire({ kind: "set_preference", search: "reminders.briefing_time", details: "null" }),
      ),
    ).toMatchObject({ value: false });
    for (const bad of [
      wire({ kind: "set_preference", search: "owner.display_name", details: '"x"' }),
      wire({ kind: "set_preference", search: "reminders.daily_limit", details: "9999" }),
      wire({ kind: "set_preference", search: "reminders.quiet_hours", details: "late" }),
      wire({
        kind: "set_preference",
        search: "reminders.quiet_hours",
        details: '{"start":"22:00","end":"22:00"}',
      }),
      wire({
        kind: "set_preference",
        search: "routine.awareness",
        details: '{"from":"21:00","to":"09:00"}',
      }),
      wire({ kind: "set_preference", search: "reminders.daily_limit" }),
    ]) {
      expect(() => toIntent(bad)).toThrow(IntentError);
    }
    expect(
      toIntent(
        wire({ kind: "show_schedule", from_date: "2026-10-14", through_date: "2026-10-18" }),
      ),
    ).toEqual({
      kind: "show_schedule",
      from: "2026-10-14",
      through: "2026-10-18",
    });
    expect(toIntent(wire({ kind: "show_schedule" }))).toEqual({ kind: "show_schedule" });
    expect(() =>
      toIntent(
        wire({ kind: "show_schedule", from_date: "2026-10-18", through_date: "2026-10-14" }),
      ),
    ).toThrow(IntentError);
    expect(
      toIntent(
        wire({
          kind: "plan_work",
          reference: "chem",
          due_date: "2026-10-15",
          due_time: "16:00",
          estimated_minutes: 60,
        }),
      ),
    ).toEqual({
      kind: "plan_work",
      reference: "chem",
      date: "2026-10-15",
      time: "16:00",
      minutes: 60,
    });
    expect(() =>
      toIntent(wire({ kind: "plan_work", reference: "chem", due_date: "2026-10-15" })),
    ).toThrow(IntentError);
    expect(
      toIntent(wire({ kind: "remember", details: "Homework before gaming", explicit: true })),
    ).toEqual({
      kind: "remember",
      text: "Homework before gaming",
      explicit: true,
    });
    expect(toIntent(wire({ kind: "remember", details: "x" }))).toMatchObject({ explicit: false });
    expect(toIntent(wire({ kind: "list_memory" }))).toEqual({ kind: "list_memory" });
    expect(toIntent(wire({ kind: "forget", reference: "gaming" }))).toEqual({
      kind: "forget",
      reference: "gaming",
    });
    expect(toIntent(wire({ kind: "snooze" }))).toEqual({ kind: "snooze", minutes: 30 });
    expect(toIntent(wire({ kind: "snooze", estimated_minutes: 45 }))).toEqual({
      kind: "snooze",
      minutes: 45,
    });
    expect(toIntent(wire({ kind: "skip_event" }))).toEqual({ kind: "skip_event" });
    expect(toIntent(wire({ kind: "pause_reminders" }))).toEqual({ kind: "pause_reminders" });
    expect(toIntent(wire({ kind: "pause_reminders", estimated_minutes: 120 }))).toEqual({
      kind: "pause_reminders",
      minutes: 120,
    });
    expect(toIntent(wire({ kind: "resume_reminders" }))).toEqual({ kind: "resume_reminders" });
    expect(
      toIntent(wire({ kind: "start_activity", title: "gaming", estimated_minutes: 60 })),
    ).toEqual({
      kind: "start_activity",
      activity: "gaming",
      minutes: 60,
    });
    expect(() => toIntent(wire({ kind: "start_activity", title: "gaming" }))).toThrow(IntentError);
    expect(() => toIntent(wire({ kind: "start_activity", estimated_minutes: 30 }))).toThrow(
      IntentError,
    );
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

  it("parses a capture of several items and a recategorize", () => {
    const item = (over: Record<string, unknown>) => ({
      type: "task",
      title: "Essay",
      details: null,
      due_date: null,
      due_time: null,
      estimated_minutes: null,
      category: null,
      review: null,
      ...over,
    });
    expect(
      toIntent(
        wire({
          kind: "capture",
          items: [
            item({ due_date: "2026-10-16", due_time: "17:00", category: "School" }),
            item({ type: "idea", title: " App idea ", review: "no date" }),
          ],
        }),
      ),
    ).toEqual({
      kind: "capture",
      items: [
        {
          type: "task",
          title: "Essay",
          dueDate: "2026-10-16",
          dueTime: "17:00",
          category: "School",
        },
        { type: "idea", title: "App idea", review: "no date" },
      ],
    });
    expect(
      toIntent(wire({ kind: "recategorize", reference: "the essay", category: "School" })),
    ).toEqual({ kind: "recategorize", reference: "the essay", category: "School" });

    const bad = [
      wire({ kind: "capture", items: [] }),
      wire({ kind: "capture", items: null }),
      wire({ kind: "capture", items: [item({ title: "  " })] }),
      wire({ kind: "capture", items: [item({ due_time: "17:00" })] }),
      wire({ kind: "capture", items: [item({ due_date: "2026-02-31" })] }),
      wire({ kind: "recategorize", reference: "x" }),
    ];
    for (const value of bad) expect(() => toIntent(value)).toThrow(IntentError);

    const many = toIntent(
      wire({
        kind: "capture",
        items: Array.from({ length: MAX_CAPTURE_ITEMS + 5 }, (_, index) =>
          item({ title: `T${index}` }),
        ),
      }),
    );
    expect(many).toMatchObject({ kind: "capture", omitted: 5 });
    expect((many as { items: unknown[] }).items).toHaveLength(MAX_CAPTURE_ITEMS);
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

  it("leaves out keywords strict structured outputs may reject, but still enforces them locally", () => {
    const text = JSON.stringify(intentJsonSchema());
    expect(text).not.toMatch(/"(default|minLength|maxLength)"/);
    expect(() => toIntent(wire({ kind: "respond", text: "x".repeat(4001) }))).toThrow(IntentError);
  });
});
