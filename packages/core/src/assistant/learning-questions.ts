export const LEARNING_CHECK_IN_PREFIX = "Optional Epi check-in: ";
export const LEARNING_QUESTION_GAP_MS = 3 * 24 * 60 * 60_000;

const QUESTIONS = [
  ["focus-time", "When do you usually feel most ready for focused work?"],
  ["reply-length", "Do you prefer my replies short and direct, or with a little explanation?"],
  ["tone", "Would you rather I sound casual and relaxed, or more straightforward and practical?"],
  [
    "work-sessions",
    "Do short sessions or longer uninterrupted blocks tend to work better for you?",
  ],
  [
    "encouragement",
    "When you're stuck, is encouragement helpful, or would you rather get a concrete next step?",
  ],
  ["busy-plans", "When a plan feels too full, do you prefer more breaks or fewer commitments?"],
  ["reminder-tone", "What makes a reminder feel helpful rather than nagging to you?"],
  ["planning-detail", "Do you prefer a detailed plan or a few priorities with room to improvise?"],
  ["starting-work", "What usually helps you get started on something you've been putting off?"],
  [
    "changed-plans",
    "When plans change, would you rather see alternatives or one recommended next step?",
  ],
  ["feedback", "How would you like me to point out a plan that might be unrealistic?"],
  [
    "assistant-style",
    "Is there anything about the way I respond that you'd like me to do differently?",
  ],
] as const;

export function askedLearningQuestions(value: unknown): string[] {
  const previous =
    value && typeof value === "object" ? (value as { asked?: unknown; index?: unknown }) : {};
  const asked = Array.isArray(previous.asked)
    ? previous.asked.filter((id): id is string => typeof id === "string")
    : [];
  // Older versions rotated through three questions. Do not start that cycle over.
  if (!Array.isArray(previous.asked) && typeof previous.index === "number") {
    asked.push("focus-time", "work-sessions", "busy-plans");
  }
  return asked;
}

export function nextLearningQuestion(value: unknown) {
  const asked = askedLearningQuestions(value);
  const next = QUESTIONS.find(([id]) => !asked.includes(id));
  return next ? { question: next[1], asked: [...asked, next[0]] } : null;
}

export function learningQuestionDue(value: unknown, now: Date, day: string) {
  const previous =
    value && typeof value === "object" ? (value as { day?: string; at?: string }) : {};
  if (previous.day === day) return false;
  if (previous.at) {
    const elapsed = now.getTime() - Date.parse(previous.at);
    if (!Number.isFinite(elapsed) || elapsed < LEARNING_QUESTION_GAP_MS) return false;
  }
  return true;
}
