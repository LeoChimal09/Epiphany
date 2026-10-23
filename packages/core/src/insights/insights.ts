import { similarTitles } from "../assistant/matching";

// Evidence-backed observations about how the owner works, and the cautious conclusions drawn from
// them. Only things the owner chose to report are ever observed (for example "that took me 40
// minutes", or snoozing a reminder). Silence is never an observation, and a single data point never
// becomes a conclusion.

export type ObservationKind = "duration" | "snooze";

export interface Observation {
  kind: ObservationKind;
  // What it is about: a task title for a duration, a reminder kind for a snooze.
  key: string;
  // Minutes spent, or minutes snoozed.
  value: number;
  at: Date;
}

export interface Insight {
  kind: "estimate" | "snooze_habit";
  key: string;
  // The conclusion (typical minutes) and how many reports back it.
  value: number;
  evidence: number;
  text: string;
}

export const DEFAULT_MIN_EVIDENCE = 3;

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

// A better time estimate for a new task, from how long similar ones took, or null when there is not
// enough evidence. The owner's own correction always wins and needs no evidence.
export function estimateFor(
  title: string,
  observations: readonly Observation[],
  options: {
    corrections?: readonly { key: string; minutes: number }[];
    minEvidence?: number;
  } = {},
): { minutes: number; source: "correction" | "reports"; evidence: number } | null {
  const correction = options.corrections?.find((entry) => similarTitles(entry.key, title));
  if (correction) return { minutes: correction.minutes, source: "correction", evidence: 0 };
  const similar = observations.filter(
    (observation) => observation.kind === "duration" && similarTitles(observation.key, title),
  );
  if (similar.length < (options.minEvidence ?? DEFAULT_MIN_EVIDENCE)) return null;
  return {
    minutes: median(similar.map((observation) => observation.value)),
    source: "reports",
    evidence: similar.length,
  };
}

// Conclusions worth showing the owner for review. Each states how much it rests on, and none is
// produced from fewer reports than the evidence threshold.
export function buildInsights(
  observations: readonly Observation[],
  options: { minEvidence?: number } = {},
): Insight[] {
  const min = options.minEvidence ?? DEFAULT_MIN_EVIDENCE;
  const insights: Insight[] = [];

  const durations = new Map<string, Observation[]>();
  for (const observation of observations.filter((o) => o.kind === "duration")) {
    const group =
      [...durations.keys()].find((key) => similarTitles(key, observation.key)) ?? observation.key;
    durations.set(group, [...(durations.get(group) ?? []), observation]);
  }
  for (const [key, group] of durations) {
    if (group.length < min) continue;
    const typical = median(group.map((o) => o.value));
    insights.push({
      kind: "estimate",
      key,
      value: typical,
      evidence: group.length,
      text: `"${key}" usually takes about ${typical} minutes (from ${group.length} times you told me).`,
    });
  }

  const snoozes = new Map<string, Observation[]>();
  for (const observation of observations.filter((o) => o.kind === "snooze")) {
    snoozes.set(observation.key, [...(snoozes.get(observation.key) ?? []), observation]);
  }
  // Snoozing is common and noisy, so it takes a stronger pattern than a time estimate.
  for (const [key, group] of snoozes) {
    if (group.length < min + 2) continue;
    insights.push({
      kind: "snooze_habit",
      key,
      value: median(group.map((o) => o.value)),
      evidence: group.length,
      text: `You've snoozed ${key.replace("_", " ")} reminders ${group.length} times, usually for about ${median(group.map((o) => o.value))} minutes.`,
    });
  }
  return insights.toSorted((a, b) => b.evidence - a.evidence);
}
