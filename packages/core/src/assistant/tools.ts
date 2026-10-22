import { z } from "zod";
import { IntentError, intentWireSchema, toIntent, type Intent } from "./intent";

type Action = Exclude<Intent["kind"], "respond" | "clarify">;
type Field = Exclude<keyof typeof intentWireSchema.shape, "kind" | "text">;

// Only action-specific arguments travel over the wire. The legacy envelope remains internal
// so scripted providers and the existing semantic validation/dispatch stay unchanged.
const fields = {
  list_tasks: ["status", "from_date", "through_date", "search"],
  create_task: ["title", "details", "due_date", "due_time", "estimated_minutes"],
  create_note: ["title", "details", "note_kind"],
  develop_idea: ["reference", "target_id", "details"],
  resume_idea: ["reference", "target_id"],
  capture: ["items"],
  recategorize: ["reference", "target_id", "category"],
  complete_task: ["reference", "target_id"],
  delete_note: ["reference", "target_id"],
  setup_workspace: ["reference"],
  snooze: ["estimated_minutes"],
  skip_event: [],
  pause_reminders: ["estimated_minutes"],
  resume_reminders: [],
  start_activity: ["title", "estimated_minutes"],
  voice_control: ["search"],
  report_duration: ["reference", "target_id", "estimated_minutes"],
  show_insights: [],
  correct_estimate: ["title", "estimated_minutes"],
  forget_insights: [],
  set_preference: ["search", "details", "title"],
  show_schedule: ["from_date", "through_date"],
  plan_work: ["reference", "target_id", "due_date", "due_time", "estimated_minutes"],
  remember: ["details", "explicit"],
  list_memory: [],
  forget: ["reference"],
  undo: [],
  confirm: [],
  decline: [],
} satisfies Record<Action, Field[]>;

const required: Partial<Record<Action, Field[]>> = {
  create_task: ["title"],
  create_note: ["details"],
  develop_idea: ["details"],
  capture: ["items"],
  recategorize: ["category"],
  start_activity: ["title", "estimated_minutes"],
  voice_control: ["search"],
  report_duration: ["estimated_minutes"],
  correct_estimate: ["title", "estimated_minutes"],
  set_preference: ["search", "details"],
  plan_work: ["due_date", "due_time"],
  remember: ["details"],
  forget: ["reference"],
};

const itemSchema = intentWireSchema.shape.items
  .unwrap()
  .element.partial()
  .required({ type: true, title: true });

const schemas = new Map(
  Object.entries(fields).map(([name, keys]) => [
    name,
    z
      .object(
        Object.fromEntries(
          keys.map((key) => {
            const schema =
              key === "items"
                ? z.array(itemSchema).min(1).max(200)
                : intentWireSchema.shape[key].unwrap();
            return [key, required[name as Action]?.includes(key) ? schema : schema.optional()];
          }),
        ),
      )
      .strict(),
  ]),
);

export const ACTION_TOOLS = [...schemas].map(([name, schema]) => {
  const parameters = z.toJSONSchema(schema);
  delete parameters.$schema;
  return {
    type: "function" as const,
    function: { name, description: `Request ${name.replaceAll("_", " ")}.`, parameters },
  };
});

const emptyWire = Object.fromEntries(Object.keys(intentWireSchema.shape).map((key) => [key, null]));
const emptyItem = Object.fromEntries(Object.keys(itemSchema.shape).map((key) => [key, null]));

export function toolToIntent(name: string, raw: unknown, text?: string): Intent {
  const schema = schemas.get(name);
  if (!schema) throw new IntentError("unknown action");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new IntentError("invalid action arguments");
  const args = parsed.data;
  return toIntent({
    ...emptyWire,
    ...args,
    kind: name,
    text: text?.trim().slice(0, 4000) || null,
    ...(Array.isArray(args.items)
      ? { items: args.items.map((item) => ({ ...emptyItem, ...item })) }
      : {}),
  });
}
