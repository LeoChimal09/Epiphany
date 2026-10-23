import type { DateKey } from "./time";
import type { FreeWindow } from "./availability";

export const DEFAULT_TASK_MINUTES = 30;

export interface PlanningTask {
  id: string;
  title: string;
  due?: DateKey | null;
  estimatedMinutes?: number | null;
}

export interface WorkBlockRecommendation {
  taskId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  minutes: number;
  reason: "deadline" | "available-time";
}

function taskPriority(task: PlanningTask): [number, string, string] {
  return [task.due ? 0 : 1, task.due ?? "9999-12-31", task.title.toLocaleLowerCase()];
}

// Suggests at most one contiguous block per task. It never mutates tasks or windows and never
// proposes a block larger than the available window, so callers can show these as proposals.
export function recommendWorkBlocks(
  tasks: readonly PlanningTask[],
  windows: readonly FreeWindow[],
  limit = 5,
): WorkBlockRecommendation[] {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Recommendation limit must be positive.");
  const orderedTasks = tasks
    .filter(
      (task) =>
        task.estimatedMinutes === undefined ||
        task.estimatedMinutes === null ||
        task.estimatedMinutes > 0,
    )
    .toSorted((first, second) => {
      const a = taskPriority(first);
      const b = taskPriority(second);
      return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
    });
  const orderedWindows = windows.toSorted(
    (first, second) => first.start.getTime() - second.start.getTime(),
  );
  const used = new Set<string>();
  const recommendations: WorkBlockRecommendation[] = [];

  for (const task of orderedTasks) {
    if (recommendations.length >= limit) break;
    const required = task.estimatedMinutes ?? DEFAULT_TASK_MINUTES;
    const window = orderedWindows.find(
      (candidate) => !used.has(candidate.start.toISOString()) && candidate.minutes >= required,
    );
    if (!window) continue;
    used.add(window.start.toISOString());
    recommendations.push({
      taskId: task.id,
      title: task.title,
      startsAt: window.start,
      endsAt: new Date(window.start.getTime() + required * 60_000),
      minutes: required,
      reason: task.due ? "deadline" : "available-time",
    });
  }
  return recommendations;
}
