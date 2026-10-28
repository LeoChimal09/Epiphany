export interface DashboardTask {
  splitReminderCount?: number | null;
  id: string;
  categoryId: string;
  taskType: "task" | "todo";
  title: string;
  priority: "minor" | "major";
  details: string | null;
  sourceText: string | null;
  // What still needs the owner's review (for example a missing due date), or null.
  reviewNote: string | null;
  status: "open" | "completed";
  dueAt: string | null;
  dueDateOnly: boolean;
  estimatedMinutes: number | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  version: number;
}

export interface DashboardNote {
  id: string;
  categoryId: string;
  title: string | null;
  body: string;
  kind: "note" | "idea";
  createdAt: string;
  version: number;
}

export interface DashboardCategory {
  id: string;
  name: string;
  systemKey: string | null;
}

export type DashboardView =
  "assistant" | "today" | "week" | "tasks" | "completed" | "notes" | "category" | "history";

export interface HistoryFilters {
  status: "all" | "open" | "completed";
  search: string;
  categoryId: string;
  from: string;
  through: string;
}

export type TaskFilter = "all" | "planned" | "todo" | "events";

export interface DashboardData {
  tasks: DashboardTask[];
  notes: DashboardNote[];
  categories: DashboardCategory[];
  timezone: string;
  capturedAt: string;
  tasksTruncated: boolean;
  notesTruncated: boolean;
}

export function visibleTasks(
  tasks: DashboardTask[],
  view: DashboardView,
  search: string,
  categoryId?: string | null,
  filter: TaskFilter = "all",
): DashboardTask[] {
  if (
    filter === "events" ||
    view === "notes" ||
    view === "history" ||
    view === "today" ||
    view === "week"
  )
    return [];
  const query = search.trim().toLocaleLowerCase();
  return tasks
    .filter((task) => (view === "completed" ? task.status === "completed" : task.status === "open"))
    .filter((task) => {
      return (
        filter === "all" ||
        (filter === "planned" ? task.taskType === "task" : task.taskType === "todo")
      );
    })
    .filter((task) => !categoryId || task.categoryId === categoryId)
    .filter((task) =>
      `${task.title} ${task.details ?? ""} ${task.sourceText ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
    )
    .toSorted((first, second) => {
      if (view === "completed") {
        return (second.completedAt ?? "").localeCompare(first.completedAt ?? "");
      }
      return (first.dueAt ?? "9999").localeCompare(second.dueAt ?? "9999");
    });
}

export function taskPage(tasks: DashboardTask[], requestedPage: number) {
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(tasks.length / pageSize));
  const page = Math.max(0, Math.min(Math.trunc(requestedPage), pages - 1));
  return { items: tasks.slice(page * pageSize, (page + 1) * pageSize), page, pages };
}

export function countdownLabel(
  value: string | null,
  timezone: string,
  dateOnly: boolean,
  now = new Date(),
): string {
  if (!value) return "No deadline";
  const dueDate = new Date(value);
  if (Number.isNaN(dueDate.getTime())) return "Date unavailable";
  if (!dateOnly) {
    const difference = dueDate.getTime() - now.getTime();
    if (difference === 0) return "Due now";
    const duration = deadlineDuration(Math.abs(difference), difference > 0);
    return difference > 0 ? `Due in ${duration}` : `Overdue ${duration}`;
  }
  const todayKey = dateKeyInTimezone(now.toISOString(), timezone);
  const dueKey = dateOnly ? dueDate.toISOString().slice(0, 10) : dateKeyInTimezone(value, timezone);
  if (!todayKey || !dueKey) return "Date unavailable";
  const dayDelta = Math.round(
    (Date.parse(`${dueKey}T00:00:00.000Z`) - Date.parse(`${todayKey}T00:00:00.000Z`)) / 86_400_000,
  );
  if (dayDelta < 0)
    return `Overdue ${Math.abs(dayDelta)} ${Math.abs(dayDelta) === 1 ? "day" : "days"}`;
  if (dayDelta === 0) return "Due today";
  if (dayDelta === 1) return "Due tomorrow";
  return `Due in ${dayDelta} days`;
}

function deadlineDuration(milliseconds: number, roundUp: boolean): string {
  if (milliseconds < 60_000) return "less than 1 minute";
  let minutes = roundUp ? Math.ceil(milliseconds / 60_000) : Math.floor(milliseconds / 60_000);
  const days = Math.floor(minutes / 1440);
  minutes %= 1440;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return [
    days ? `${days} ${days === 1 ? "day" : "days"}` : "",
    hours ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "",
    minutes ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface DeadlineNotification {
  task: DashboardTask;
  kind: "due-soon" | "due-now" | "overdue" | "due-today";
  label: string;
}

// A live projection of authorized tasks, not another reminder queue. Nothing here completes work.
export function deadlineNotifications(
  tasks: DashboardTask[],
  timezone: string,
  now: Date,
): DeadlineNotification[] {
  const notifications: DeadlineNotification[] = [];
  for (const task of tasks) {
    if (task.status !== "open" || task.archivedAt || !task.dueAt) continue;
    const due = new Date(task.dueAt).getTime();
    if (!Number.isFinite(due)) continue;
    const label = countdownLabel(task.dueAt, timezone, task.dueDateOnly, now);
    let kind: DeadlineNotification["kind"];
    if (task.dueDateOnly) {
      if (label.startsWith("Overdue")) kind = "overdue";
      else if (label === "Due today") kind = "due-today";
      else continue;
    } else {
      const remaining = due - now.getTime();
      if (remaining > 3_600_000) continue;
      kind = remaining < 0 ? "overdue" : remaining === 0 ? "due-now" : "due-soon";
    }
    notifications.push({ task, kind, label });
  }
  const urgency = { "due-now": 0, "due-soon": 1, overdue: 2, "due-today": 3 };
  return notifications.toSorted((first, second) => {
    const byUrgency = urgency[first.kind] - urgency[second.kind];
    const byDeadline = Date.parse(first.task.dueAt!) - Date.parse(second.task.dueAt!);
    return byUrgency || byDeadline || first.task.id.localeCompare(second.task.id);
  });
}

export function visibleHistoryTasks(
  tasks: DashboardTask[],
  filters: HistoryFilters,
  categories: DashboardCategory[],
  timezone: string,
): DashboardTask[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  return tasks
    .filter((task) => filters.status === "all" || task.status === filters.status)
    .filter((task) => !filters.categoryId || task.categoryId === filters.categoryId)
    .filter((task) => {
      const category = categoryNames.get(task.categoryId) ?? "Inbox";
      return `${task.title} ${task.details ?? ""} ${task.sourceText ?? ""} ${category}`
        .toLocaleLowerCase()
        .includes(query);
    })
    .filter((task) => {
      const activityDate = task.completedAt ?? task.createdAt;
      const day = dateKeyInTimezone(activityDate, timezone);
      return (
        day !== null &&
        (!filters.from || day >= filters.from) &&
        (!filters.through || day <= filters.through)
      );
    })
    .toSorted((first, second) => {
      const firstDate = first.completedAt ?? first.createdAt;
      const secondDate = second.completedAt ?? second.createdAt;
      return secondDate.localeCompare(firstDate);
    });
}

function dateKeyInTimezone(value: string, timezone: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function visibleNotes(
  notes: DashboardNote[],
  search: string,
  categoryId?: string | null,
): DashboardNote[] {
  const query = search.trim().toLocaleLowerCase();
  return notes.filter(
    (note) =>
      (!categoryId || note.categoryId === categoryId) &&
      `${note.title ?? ""} ${note.body}`.toLocaleLowerCase().includes(query),
  );
}

export function formatDate(value: string | null, timezone: string, dateOnly = false): string {
  if (!value) return "No deadline";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: dateOnly ? "UTC" : timezone,
    ...(dateOnly ? {} : { hour: "numeric", minute: "2-digit" }),
  }).format(date);
}

export function dateTimeLocalValue(value: string | null, timezone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function localDateTimeToIso(value: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid date and time.");
  const [, year, month, day, hour, minute] = match;
  const wanted = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  let guess = wanted;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? "00";
    const represented = Date.UTC(
      Number(part("year")),
      Number(part("month")) - 1,
      Number(part("day")),
      Number(part("hour")),
      Number(part("minute")),
    );
    const difference = wanted - represented;
    if (difference === 0) return new Date(guess).toISOString();
    guess += difference;
  }
  throw new Error("That local time does not exist because of a timezone clock change.");
}

export function parseEffort(value: FormDataEntryValue | null): number | undefined {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Enter a whole number of minutes.");
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 100_000) {
    throw new Error("Estimated time must be between 1 and 100,000 whole minutes.");
  }
  return minutes;
}
