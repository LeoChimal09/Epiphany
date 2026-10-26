"use client";

import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  Bot,
  CalendarClock,
  CalendarDays,
  Check,
  CircleCheck,
  Clock,
  FileText,
  Folder,
  Globe2,
  History,
  Inbox,
  Info,
  Lightbulb,
  ListChecks,
  LogOut,
  NotebookText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { AccountMenu } from "./account-menu";
import { ConfirmationDialog, type DashboardConfirmation } from "./confirmation-dialog";
import { AssistantChat, type AssistantSetup, type ChatMessage } from "./assistant-chat";
import type { ConversationState } from "@epiphany/core/assistant";
import type { OwnerProfile } from "@epiphany/core/services";
import type { VoiceStatus } from "./voice-status";
import {
  addDashboardCategory,
  addDashboardEvent,
  addDashboardNote,
  addDashboardTask,
  askEpi,
  cancelDashboardEvent,
  editDashboardNote,
  editDashboardTask,
  finishDashboardTask,
  finishDashboardTasks,
  proposeDashboardNoteDeletion,
  confirmDashboardNoteDeletion,
  cancelDashboardNoteDeletion,
  loadDashboardHistory,
  loadDashboardSchedule,
  loadMoreDashboardNotes,
  refreshDashboard,
  removeDashboardWorkBlock,
  reopenDashboardTask,
  type DashboardResult,
  type DashboardScheduleChangeResult,
} from "./actions";
import {
  countdownLabel,
  dateTimeLocalValue,
  formatDate,
  localDateTimeToIso,
  taskPage,
  visibleHistoryTasks,
  visibleNotes,
  visibleTasks,
  type DashboardCategory,
  type DashboardData,
  type DashboardNote,
  type DashboardTask,
  type DashboardView,
  type HistoryFilters,
  type TaskFilter,
} from "./model";
import { CalendarView } from "./calendar-view";
import { DeadlineNotifications } from "./deadline-notifications";
import { IdeaBody } from "./idea-body";
import {
  formatDayLabel,
  todayKey,
  weekStartOf,
  type ScheduleData,
  type TimelineItem,
} from "./schedule";
import styles from "./workspace.module.css";

const LIVE_REFRESH_MS = 30_000;

const headings: Record<DashboardView, string> = {
  assistant: "Ask Epi",
  today: "Calendar",
  week: "Calendar",
  tasks: "Active tasks",
  completed: "Completed tasks",
  notes: "Notes & ideas",
  category: "Category",
  history: "Task history",
};

export function DashboardShell({
  initialData,
  initialSchedule,
  assistantSetup,
  devBypass,
  owner,
  voice,
}: {
  initialData: DashboardData;
  initialSchedule: ScheduleData | null;
  assistantSetup: AssistantSetup;
  devBypass: boolean;
  owner: OwnerProfile;
  voice: VoiceStatus;
}) {
  const [data, setData] = useState(initialData);
  const homeView: DashboardView = assistantSetup === "ready" ? "assistant" : "today";
  const [view, setView] = useState<DashboardView>(homeView);
  const [chat, setChat] = useState<{
    messages: ChatMessage[];
    conversation: ConversationState;
    asking: boolean;
    budgetNote: string | null;
  }>({
    messages: [],
    conversation: { turns: [], listed: [], pending: null },
    asking: false,
    budgetNote: null,
  });
  const nextMessageId = useRef(1);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const deferredSearch = useDeferredValue(search);
  const [composer, setComposer] = useState<"task" | "note" | null>(null);
  const [calendarEntryType, setCalendarEntryType] = useState<"task" | "event">("task");
  const [eventAllDay, setEventAllDay] = useState(false);
  const [eventTimingMode, setEventTimingMode] = useState<"end" | "duration">("end");
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [historyTasks, setHistoryTasks] = useState<DashboardTask[]>([]);
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(0);
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>({
    status: "all",
    search: "",
    categoryId: "",
    from: "",
    through: "",
  });
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<DashboardConfirmation | null>(null);
  const [pending, startTransition] = useTransition();
  // Starts from the server's clock so hydration matches, then follows the browser clock.
  const [now, setNow] = useState(() => new Date(initialData.capturedAt));
  const [schedule, setSchedule] = useState(initialSchedule);
  const [weekStart, setWeekStart] = useState(() =>
    weekStartOf(todayKey(initialData.timezone, new Date(initialData.capturedAt))),
  );
  const requestedWeek = useRef(weekStart);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = todayKey(data.timezone, now);
  const isSchedule = view === "today" || view === "week";
  const isAssistant = view === "assistant";
  const neededWeek = view === "today" ? weekStartOf(today) : weekStart;
  // Changes made in Discord appear here without a manual refresh: the visible dashboard re-reads
  // every half minute and when the tab regains focus. It waits while an action or a chat turn is
  // in flight, and drops a result that arrives after one started, so it never overwrites an edit.
  const live = useRef({ busy: false, week: neededWeek, skipSchedule: false });
  live.current = {
    busy: pending || chat.asking,
    week: neededWeek,
    skipSchedule: view === "history",
  };
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (document.visibilityState !== "visible" || live.current.busy) return;
      try {
        const [fresh, week] = await Promise.all([
          refreshDashboard(),
          live.current.skipSchedule ? null : loadDashboardSchedule(live.current.week),
        ]);
        if (cancelled || live.current.busy) return;
        if (fresh.ok && fresh.data) {
          const next = fresh.data;
          setData((current) => ({ ...current, ...next, capturedAt: new Date().toISOString() }));
        }

        if (week?.ok && requestedWeek.current === week.schedule.weekStart)
          setSchedule(week.schedule);
      } catch {
        // A missed refresh is harmless; the next one tries again.
      }
    }
    const timer = window.setInterval(poll, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);
  const open = data.tasks.filter((task) => task.status === "open");
  const completed = data.tasks.filter((task) => task.status === "completed");
  const inbox = data.categories.find((category) => category.systemKey === "inbox");
  const selectedCategory = data.categories.find((category) => category.id === categoryFilter);
  const title = view === "category" ? (selectedCategory?.name ?? "Category") : headings[view];
  const tasks = visibleTasks(
    data.tasks,
    view,
    isAssistant ? "" : deferredSearch,
    view === "category" ? categoryFilter : null,
    view === "tasks" ? taskFilter : "all",
  );
  const notes = visibleNotes(
    data.notes,
    deferredSearch,
    view === "category" ? categoryFilter : null,
  );
  const history = visibleHistoryTasks(historyTasks, historyFilters, data.categories, data.timezone);
  const estimatedMinutes = open.reduce((total, task) => total + (task.estimatedMinutes ?? 0), 0);

  function perform(
    operation: () => Promise<DashboardResult>,
    onSuccess?: (result: Extract<DashboardResult, { ok: true }>) => void,
  ) {
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await operation();
        if (!result.ok) {
          setNotice({ text: result.error, error: true });
          return;
        }
        setData((current) => ({
          ...current,
          ...(result.data ? result.data : {}),
          capturedAt: new Date().toISOString(),
          tasks:
            result.data?.tasks ??
            (result.task
              ? [result.task, ...current.tasks.filter((task) => task.id !== result.task?.id)]
              : current.tasks),
          notes:
            result.data?.notes ??
            (result.note
              ? [result.note, ...current.notes.filter((note) => note.id !== result.note?.id)]
              : current.notes),
          categories:
            result.data?.categories ??
            (result.category
              ? [
                  ...current.categories.filter((category) => category.id !== result.category?.id),
                  result.category,
                ]
              : current.categories),
        }));
        if (result.task) {
          setHistoryTasks((current) => {
            const exists = current.some((task) => task.id === result.task?.id);
            return exists
              ? current.map((task) => (task.id === result.task?.id ? result.task! : task))
              : current;
          });
        }
        if (result.data) {
          const updated = new Map(
            [...result.data.tasks, ...(result.updatedTasks ?? [])].map((task) => [task.id, task]),
          );
          setHistoryTasks((current) => current.map((task) => updated.get(task.id) ?? task));
        }
        setNotice({ text: result.message, error: result.partialFailure ?? false });
        onSuccess?.(result);
      } catch {
        setNotice({
          text: "The request did not finish. Refresh before retrying, or sign in again.",
          error: true,
        });
      }
    });
  }

  function prepareTaskForm(form: HTMLFormElement, editing: boolean): FormData | null {
    const fields = new FormData(form);
    const localDue = fields.get("dueAt");
    if (typeof localDue === "string" && localDue) {
      try {
        fields.set("dueAt", localDateTimeToIso(localDue, data.timezone));
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : "Enter a valid deadline.",
          error: true,
        });
        return null;
      }
    } else if (editing) {
      fields.set("dueAt", "");
    }
    return fields;
  }

  function submitCalendarEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (calendarEntryType === "event") {
      changeSchedule(() => addDashboardEvent(new FormData(form)), {
        week: neededWeek,
        onSuccess: () => {
          form.reset();
          setComposer(null);
          setCalendarEntryType("task");
          setEventAllDay(false);
          setEventTimingMode("end");
        },
      });
      return;
    }
    const fields = prepareTaskForm(form, false);
    if (!fields) return;
    perform(
      () => addDashboardTask(fields),
      () => {
        form.reset();
        setComposer(null);
        if (isSchedule) {
          loadWeek(neededWeek);
        } else {
          setView("tasks");
          setCategoryFilter(null);
          setSearch("");
        }
      },
    );
  }

  function openTaskComposer() {
    setCalendarEntryType("task");
    setEventAllDay(false);
    setEventTimingMode("end");
    setComposer("task");
  }

  function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    perform(
      () => addDashboardNote(fields),
      () => {
        form.reset();
        setComposer(null);
        setView("notes");
        setCategoryFilter(null);
        setSearch("");
      },
    );
  }

  function submitCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    perform(
      () => addDashboardCategory(fields),
      (result) => {
        form.reset();
        setShowCategoryForm(false);
        if (result.category) {
          setView("category");
          setCategoryFilter(result.category.id);
        }
      },
    );
  }

  function selectView(next: DashboardView) {
    setTaskFilter("all");
    setView(next);
    setCategoryFilter(null);
    setSearch("");
    setComposer(null);
    if (next === "today" || next === "week") {
      const week = next === "today" ? weekStartOf(today) : weekStart;
      if (schedule?.weekStart !== week) loadWeek(week);
    }
    if (next === "history") {
      setHistoryTasks([]);
      setHistoryNextOffset(0);
      loadHistoryPage(0, true);
    }
  }

  async function sendToEpi(text: string) {
    if (chat.asking) return;
    const userMessage: ChatMessage = { id: nextMessageId.current++, role: "user", text };
    setChat((current) => ({
      ...current,
      messages: [...current.messages, userMessage],
      asking: true,
    }));
    let conversation = chat.conversation;
    let budgetNote = chat.budgetNote;
    let reply: ChatMessage;
    let changed = false;
    try {
      const result = await askEpi(text, chat.conversation);
      if (result.ok) {
        conversation = result.state;
        budgetNote = result.budgetNote;
        changed = result.reply.changed;
        reply = {
          id: nextMessageId.current++,
          role: "epi",
          text: result.reply.text,
          outcome: result.reply.outcome,
          changed: result.reply.changed,
        };
      } else {
        reply = { id: nextMessageId.current++, role: "epi", text: result.error, outcome: "failed" };
      }
    } catch {
      reply = {
        id: nextMessageId.current++,
        role: "epi",
        text: "The request did not finish. Refresh to check your records.",
        outcome: "failed",
      };
    }
    setChat((current) => ({
      ...current,
      messages: [...current.messages, reply],
      conversation,
      asking: false,
      budgetNote,
    }));
    if (changed) {
      const [fresh, week] = await Promise.all([
        refreshDashboard(),
        loadDashboardSchedule(schedule?.weekStart ?? weekStartOf(today)),
      ]);
      if (fresh.ok && fresh.data)
        setData((current) => ({ ...current, ...fresh.data, capturedAt: new Date().toISOString() }));
      if (week.ok) setSchedule(week.schedule);
    }
  }

  function selectCategory(category: DashboardCategory) {
    setView("category");
    setCategoryFilter(category.id);
    setSearch("");
    setComposer(null);
  }

  function createCategoryCount(categoryId: string): number {
    return (
      data.tasks.filter((task) => task.status === "open" && task.categoryId === categoryId).length +
      data.notes.filter((note) => note.categoryId === categoryId).length
    );
  }

  function editTask(taskId: string, form: HTMLFormElement, onSuccess: () => void) {
    const fields = prepareTaskForm(form, true);
    if (!fields) return;
    perform(() => editDashboardTask(taskId, fields), onSuccess);
  }

  function editNote(noteId: string, form: HTMLFormElement, onSuccess: () => void) {
    const fields = new FormData(form);
    perform(() => editDashboardNote(noteId, fields), onSuccess);
  }

  function loadWeek(week: string) {
    requestedWeek.current = week;
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await loadDashboardSchedule(week);
        // A newer request supersedes this one.
        if (requestedWeek.current !== week) return;
        if (!result.ok) {
          setNotice({ text: result.error, error: true });
          return;
        }
        setSchedule(result.schedule);
      } catch {
        if (requestedWeek.current !== week) return;
        setNotice({ text: "The schedule could not be loaded. Try again.", error: true });
      }
    });
  }

  function moveWeek(week: string) {
    setWeekStart(week);
    loadWeek(week);
  }

  // Runs a schedule change, then reloads the affected week so the views show persisted records.
  function changeSchedule(
    operation: () => Promise<DashboardScheduleChangeResult>,
    options: { week?: string; onSuccess?: () => void } = {},
  ) {
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await operation();
        if (!result.ok) {
          setNotice({ text: result.error, error: true });
          return;
        }
        options.onSuccess?.();
        const week = options.week ?? neededWeek;
        requestedWeek.current = week;
        const refreshed = await loadDashboardSchedule(week);
        if (requestedWeek.current === week && refreshed.ok) setSchedule(refreshed.schedule);
        setNotice({
          text: refreshed.ok ? result.message : `${result.message} Refresh to see it.`,
          error: false,
        });
      } catch {
        setNotice({
          text: "The request did not finish. Refresh before retrying, or sign in again.",
          error: true,
        });
      }
    });
  }

  function removeScheduleItem(item: TimelineItem) {
    changeSchedule(() =>
      item.kind === "event" ? cancelDashboardEvent(item.id) : removeDashboardWorkBlock(item.id),
    );
  }

  function loadHistoryPage(offset: number, replace = false) {
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await loadDashboardHistory(offset);
        if (!result.ok) {
          setNotice({ text: result.error, error: true });
          return;
        }
        setHistoryTasks((current) =>
          replace
            ? result.tasks
            : [
                ...current,
                ...result.tasks.filter((task) => !current.some((old) => old.id === task.id)),
              ],
        );
        setHistoryNextOffset(result.nextOffset);
      } catch {
        setNotice({ text: "History could not be loaded. Try refreshing this view.", error: true });
      }
    });
  }

  function loadMoreNotes() {
    setNotice(null);
    startTransition(async () => {
      const result = await loadMoreDashboardNotes(data.notes.length);
      if (!result.ok) {
        setNotice({ text: result.error, error: true });
        return;
      }
      setData((current) => ({
        ...current,
        notes: [
          ...current.notes,
          ...result.notes.filter((note) => !current.notes.some((old) => old.id === note.id)),
        ],
        notesTruncated: result.hasMore,
        capturedAt: new Date().toISOString(),
      }));
      setNotice({ text: "Older notes loaded.", error: false });
    });
  }

  const addCategoryId = view === "category" ? categoryFilter : inbox?.id;

  function requestTaskCompletion(ids: string[]) {
    const selected = ids
      .map(
        (id) =>
          data.tasks.find((task) => task.id === id) ?? historyTasks.find((task) => task.id === id),
      )
      .filter((task): task is DashboardTask => task !== undefined && task.status === "open");
    if (!selected.length) return;
    setConfirmation({
      title: `Mark ${selected.length === 1 ? "task" : `${selected.length} tasks`} done?`,
      description: `${selected.map((task) => task.title).join("; ")}. Completed tasks move to history and remaining planned work blocks are cleared.`,
      confirmLabel: "Confirm done",
      onConfirm: () =>
        perform(() =>
          selected.length === 1
            ? finishDashboardTask(selected[0]!.id)
            : finishDashboardTasks(selected.map((task) => task.id)),
        ),
    });
  }

  function requestNoteDeletion(id: string) {
    startTransition(async () => {
      try {
        const result = await proposeDashboardNoteDeletion(id);
        if (!result.ok) {
          setNotice({ text: result.error, error: true });
          return;
        }
        const { proposal } = result;
        setConfirmation({
          title: "Permanently delete this note or idea?",
          description: `${proposal.summary}. This cannot be undone. Cancel to keep it.`,
          confirmLabel: "Delete permanently",
          onConfirm: () => perform(() => confirmDashboardNoteDeletion(proposal)),
          onCancel: () => {
            startTransition(async () => {
              try {
                await cancelDashboardNoteDeletion(proposal.confirmationId);
              } catch {
                setNotice({
                  text: "The deletion was not confirmed, but its pending request could not be canceled. It will expire automatically.",
                  error: true,
                });
              }
            });
          },
        });
      } catch {
        setNotice({ text: "Could not prepare deletion. Nothing was deleted.", error: true });
      }
    });
  }

  return (
    <div className={styles.workspace}>
      {confirmation ? (
        <ConfirmationDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
      ) : null}
      <header className={styles.topbar}>
        <Link
          className={styles.brand}
          href="/dashboard"
          onClick={(event) => {
            // The route does not change, so go home within the page instead of doing nothing.
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            selectView("today");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <span className={styles.logo} aria-hidden="true">
            <Sparkles size={17} />
          </span>
          <span>
            Epiphany<span className={styles.brandCaption}> Personal workspace</span>
          </span>
        </Link>
        <div className={styles.rowActions}>
          <DeadlineNotifications
            tasks={data.tasks}
            timezone={data.timezone}
            now={now}
            pending={pending}
            truncated={data.tasksTruncated && open.length >= 100}
            onComplete={(id) => requestTaskCompletion([id])}
            onOpen={(task) => {
              selectView("tasks");
              setSearch(task.title);
            }}
            onHistory={() => selectView("history")}
          />
          <AccountMenu devBypass={devBypass} owner={owner} timezone={data.timezone} />
        </div>
      </header>
      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <nav className={styles.navigation} aria-label="Dashboard views">
            {(
              [
                ["assistant", "Ask Epi", null, Bot],
                ["today", "Calendar", null, CalendarDays],
                ["tasks", "Tasks", open.length, ListChecks],
                ["completed", "Done", completed.length, CircleCheck],
                ["notes", "Notes & ideas", data.notes.length, NotebookText],
              ] as const
            ).map(([key, label, count, Icon]) => (
              <button
                key={key}
                type="button"
                aria-current={view === key || (key === "today" && isSchedule) ? "page" : undefined}
                onClick={() => selectView(key)}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
                {count === null ? null : <span className={styles.count}>{count}</span>}
              </button>
            ))}
            <button
              type="button"
              aria-current={view === "history" ? "page" : undefined}
              onClick={() => selectView("history")}
            >
              <History size={17} aria-hidden="true" />
              <span>History</span>
            </button>
          </nav>
          <div className={styles.categoryNavigation}>
            <div className={styles.categoryHeading}>
              <span>Categories</span>
              <button
                type="button"
                className={styles.textButton}
                disabled={pending}
                onClick={() => setShowCategoryForm((value) => !value)}
                aria-label="Create category"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            <nav className={styles.navigation} aria-label="Task categories">
              {data.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  aria-current={
                    view === "category" && categoryFilter === category.id ? "page" : undefined
                  }
                  onClick={() => selectCategory(category)}
                >
                  {category.systemKey === "inbox" ? (
                    <Inbox size={17} aria-hidden="true" />
                  ) : (
                    <Folder size={17} aria-hidden="true" />
                  )}
                  <span>{category.name}</span>
                  <span className={styles.count}>{createCategoryCount(category.id)}</span>
                </button>
              ))}
            </nav>
            {showCategoryForm ? (
              <form className={styles.categoryForm} onSubmit={submitCategory}>
                <label>
                  New category
                  <input name="name" required maxLength={100} autoFocus />
                </label>
                <div>
                  <button className={styles.primaryButton} disabled={pending} type="submit">
                    Create
                  </button>
                  <button
                    className={styles.textButton}
                    disabled={pending}
                    type="button"
                    onClick={() => setShowCategoryForm(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
          </div>
          <div className={styles.sidebarFooter}>
            <span className={styles.timezone}>
              <Globe2 size={13} aria-hidden="true" />
              {data.timezone}
            </span>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className={styles.signOut}>
                <LogOut size={15} aria-hidden="true" />
                Sign out
              </button>
            </form>
          </div>
        </aside>

        <main className={styles.main}>
          {devBypass ? (
            <p className={styles.devBanner} role="status">
              <ShieldAlert size={15} aria-hidden="true" />
              Local development access. Use test data only.
            </p>
          ) : null}
          <header className={styles.heading}>
            <div>
              <p className={styles.eyebrow}>
                {view === "today" ? formatDayLabel(today, "long").toUpperCase() : "YOUR WORKSPACE"}
              </p>
              <h1>{title}</h1>
            </div>
            <div className={styles.headerActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={pending}
                onClick={() => {
                  if (view === "history") loadHistoryPage(0, true);
                  else {
                    perform(refreshDashboard);
                    if (isSchedule) loadWeek(neededWeek);
                  }
                }}
              >
                <RefreshCw
                  size={15}
                  className={pending ? styles.spin : undefined}
                  aria-hidden="true"
                />
                {pending ? "Working..." : view === "history" ? "Refresh history" : "Refresh"}
              </button>
              {isSchedule ? (
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={pending}
                  onClick={openTaskComposer}
                >
                  <Plus size={16} aria-hidden="true" />
                  Add task
                </button>
              ) : view === "category" ? (
                <>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={pending}
                    onClick={openTaskComposer}
                  >
                    <Plus size={16} aria-hidden="true" />
                    Add task
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={pending}
                    onClick={() => setComposer("note")}
                  >
                    <FileText size={16} aria-hidden="true" />
                    Add note
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={pending}
                  onClick={() => setComposer(view === "notes" ? "note" : "task")}
                >
                  <Plus size={16} aria-hidden="true" />
                  {view === "notes" ? "Add note" : "Add task"}
                </button>
              )}
            </div>
          </header>

          <dl className={styles.summary}>
            <div>
              <span className={styles.summaryIcon} aria-hidden="true">
                <ListChecks size={19} />
              </span>
              <dt>Open tasks</dt>
              <dd>{open.length}</dd>
            </div>
            <div>
              <span className={styles.summaryIcon} aria-hidden="true">
                <Timer size={19} />
              </span>
              <dt>Estimated work</dt>
              <dd>
                {estimatedMinutes}
                <span> min</span>
              </dd>
            </div>
            <div>
              <span className={styles.summaryIcon} aria-hidden="true">
                <NotebookText size={19} />
              </span>
              <dt>Saved notes</dt>
              <dd>{data.notes.length}</dd>
            </div>
          </dl>

          {notice ? (
            <p
              className={notice.error ? styles.errorNotice : styles.successNotice}
              role={notice.error ? "alert" : "status"}
            >
              {notice.text}
            </p>
          ) : null}

          {composer ? (
            <section
              className={styles.composer}
              aria-label={composer === "task" ? "New task or event" : "New note"}
            >
              <div className={styles.composerHeading}>
                <h2>
                  {composer === "task"
                    ? calendarEntryType === "task"
                      ? "New task"
                      : "New event"
                    : "Capture a thought"}
                </h2>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={pending}
                  onClick={() => setComposer(null)}
                >
                  Cancel
                </button>
              </div>
              {composer === "task" ? (
                <form onSubmit={submitCalendarEntry}>
                  <fieldset disabled={pending} className={styles.fields}>
                    <label className={styles.fullWidth}>
                      Title
                      <input name="title" required maxLength={300} autoFocus />
                    </label>
                    <label className={styles.fullWidth}>
                      Type
                      <select
                        name="entryType"
                        value={calendarEntryType}
                        onChange={(event) => {
                          setCalendarEntryType(
                            event.currentTarget.value === "event" ? "event" : "task",
                          );
                          setEventAllDay(false);
                          setEventTimingMode("end");
                        }}
                      >
                        <option value="task">Task — due date or deadline</option>
                        <option value="event">Event — start and end time</option>
                      </select>
                    </label>
                    {calendarEntryType === "task" ? (
                      <>
                        <label>
                          Priority
                          <select name="priority" defaultValue="minor">
                            <option value="minor">Minor</option>
                            <option value="major">Major — extra advance reminders</option>
                          </select>
                        </label>
                        <label>
                          Due date and time ({data.timezone})
                          <input name="dueAt" type="datetime-local" />
                        </label>
                        <label>
                          Estimated minutes
                          <input
                            name="estimatedMinutes"
                            type="number"
                            min={1}
                            max={100000}
                            step={1}
                          />
                        </label>
                        <p className={styles.fullWidth}>
                          A task is a deadline. An estimate is effort only; it does not reserve
                          calendar time. Leave the due time blank if you do not know it. Deadline
                          reminders default to one hour before; your reminder settings can change
                          that. Major priorities keep their existing advance reminders.
                        </p>
                        <CategorySelect
                          categories={data.categories}
                          name="categoryId"
                          value={addCategoryId ?? ""}
                        />
                        <label className={styles.inlineCheck}>
                          <input name="dueDateOnly" type="checkbox" />
                          <span>
                            No specific due time
                            <small className={styles.checkHelp}>
                              Use the selected date only. Leave unchecked for an exact deadline.
                            </small>
                          </span>
                        </label>
                        <label className={styles.fullWidth}>
                          Details
                          <textarea name="details" rows={3} maxLength={10000} />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>
                          Date ({data.timezone})
                          <input name="date" type="date" required />
                        </label>
                        <label className={styles.inlineCheck}>
                          <input
                            name="allDay"
                            type="checkbox"
                            checked={eventAllDay}
                            onChange={(event) => setEventAllDay(event.currentTarget.checked)}
                          />
                          <span>All-day event</span>
                        </label>
                        {!eventAllDay ? (
                          <>
                            <label className={styles.fullWidth}>
                              Event timing
                              <select
                                name="eventTimingMode"
                                value={eventTimingMode}
                                onChange={(event) =>
                                  setEventTimingMode(
                                    event.currentTarget.value === "duration" ? "duration" : "end",
                                  )
                                }
                              >
                                <option value="end">Start and end time</option>
                                <option value="duration">Start time and duration</option>
                              </select>
                            </label>
                            <div className={`${styles.timeRange} ${styles.fullWidth}`}>
                              <label>
                                Start time
                                <input name="startTime" type="time" required />
                              </label>
                              {eventTimingMode === "end" ? (
                                <label>
                                  End time
                                  <input name="endTime" type="time" required />
                                </label>
                              ) : (
                                <label>
                                  Duration (minutes)
                                  <input
                                    name="durationMinutes"
                                    type="number"
                                    min={1}
                                    max={100000}
                                    step={1}
                                    required
                                  />
                                </label>
                              )}
                            </div>
                          </>
                        ) : null}
                        <label className={styles.fullWidth}>
                          Location (optional)
                          <input name="location" maxLength={300} />
                        </label>
                        <p className={styles.fullWidth}>
                          An event reserves calendar time from its start through its end. Use a task
                          when you only need a due date.
                        </p>
                      </>
                    )}
                    <div className={styles.formFooter}>
                      <button className={styles.primaryButton} type="submit">
                        {pending
                          ? "Saving..."
                          : `Save ${calendarEntryType === "task" ? "task" : "event"}`}
                      </button>
                    </div>
                  </fieldset>
                </form>
              ) : (
                <form onSubmit={submitNote}>
                  <fieldset disabled={pending} className={styles.fields}>
                    <label className={styles.fullWidth}>
                      Title (optional)
                      <input name="title" maxLength={300} autoFocus />
                    </label>
                    <CategorySelect
                      categories={data.categories}
                      name="categoryId"
                      value={addCategoryId ?? ""}
                    />
                    <fieldset className={styles.noteKinds}>
                      <legend>Type</legend>
                      <label>
                        <input name="kind" type="radio" value="note" defaultChecked />
                        Note
                      </label>
                      <label>
                        <input name="kind" type="radio" value="idea" />
                        Idea
                      </label>
                    </fieldset>
                    <label className={styles.fullWidth}>
                      Thought
                      <textarea name="body" required rows={6} maxLength={50000} />
                    </label>
                    <div className={styles.formFooter}>
                      <button className={styles.primaryButton} type="submit">
                        {pending ? "Saving..." : "Save note"}
                      </button>
                    </div>
                  </fieldset>
                </form>
              )}
            </section>
          ) : null}

          <section className={styles.records} aria-label={title} aria-busy={pending}>
            {view !== "history" && !isSchedule && !isAssistant ? (
              <div className={styles.listToolbar}>
                {view === "tasks" ? (
                  <div className={styles.rowActions} role="group" aria-label="Task filters">
                    {(
                      [
                        ["all", "All tasks"],
                        ["planned", "With due date or duration"],
                        ["plain", "Just tasks"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={styles.secondaryButton}
                        aria-pressed={taskFilter === value}
                        onClick={() => setTaskFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <label className={styles.searchLabel}>
                  Search
                  <span className={styles.searchField}>
                    <Search size={15} aria-hidden="true" />
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={
                        view === "notes" ? "Search notes and ideas" : "Search tasks and notes"
                      }
                    />
                  </span>
                </label>
                <span className={styles.updated}>
                  Updated {formatDate(data.capturedAt, data.timezone)}
                </span>
              </div>
            ) : null}
            {view !== "history" &&
            !isSchedule &&
            !isAssistant &&
            (view === "notes" ? data.notesTruncated : data.tasksTruncated) ? (
              <p className={styles.limitNotice}>
                {view === "notes"
                  ? "Showing loaded notes. Load older notes below to browse farther back."
                  : "Showing the first 100 records per task status. Use Task history to load and search older tasks."}
              </p>
            ) : null}
            {isAssistant ? (
              <AssistantChat
                setup={assistantSetup}
                messages={chat.messages}
                asking={chat.asking}
                budgetNote={chat.budgetNote}
                timezone={data.timezone}
                voice={voice}
                onSend={(text) => void sendToEpi(text)}
              />
            ) : null}
            {isSchedule ? (
              <div>
                <ul className={styles.scheduleLegend} aria-label="Legend">
                  <li>
                    <span className={`${styles.swatch} ${styles.swatchEvent}`} /> Event
                  </li>
                  <li>
                    <span className={`${styles.swatch} ${styles.swatchWork}`} /> Work block
                  </li>
                  <li>
                    <span className={`${styles.swatch} ${styles.swatchConflict}`} /> Overlap
                  </li>
                </ul>
                <p className={styles.scheduleNote}>
                  <Info size={14} aria-hidden="true" />
                  Task deadlines appear as due markers, not scheduled study sessions. External
                  calendar connections and sync status are managed in Calendars.
                </p>
                {data.tasksTruncated ? (
                  <p className={styles.limitNotice}>
                    Only loaded task deadlines are shown. Use Task history to browse tasks beyond
                    the initial 100-per-status limit.
                  </p>
                ) : null}
                {schedule && schedule.weekStart === neededWeek ? (
                  <>
                    {schedule.truncated ? (
                      <p className={`${styles.scheduleNote} ${styles.summaryConflict}`}>
                        <TriangleAlert size={14} aria-hidden="true" />
                        Some items are not shown because this week has more than the display limit.
                      </p>
                    ) : null}
                    <CalendarView
                      key={`${view}:${schedule.weekStart}`}
                      initialSchedule={schedule}
                      tasksTruncated={data.tasksTruncated}
                      initialMode={view === "today" ? "day" : "week"}
                      initialDate={
                        view === "week" && weekStart !== weekStartOf(today) ? weekStart : today
                      }
                      tasks={data.tasks}
                      timezone={data.timezone}
                      today={today}
                      now={now}
                      pending={pending}
                      onComplete={(id) => requestTaskCompletion([id])}
                      onRemove={removeScheduleItem}
                    />
                  </>
                ) : (
                  <div className={styles.empty}>
                    <CalendarClock size={26} aria-hidden="true" />
                    <h2>{pending ? "Loading schedule..." : "Schedule unavailable"}</h2>
                    {pending ? null : (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => loadWeek(neededWeek)}
                      >
                        Try again
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : null}
            {isSchedule ? null : view === "history" ? (
              <div className={styles.historyView}>
                <div className={styles.historyFilters}>
                  <label>
                    Search history
                    <input
                      type="search"
                      value={historyFilters.search}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({ ...current, search: event.target.value }))
                      }
                      placeholder="Title, details, course, or category"
                    />
                  </label>
                  <label>
                    Status
                    <select
                      value={historyFilters.status}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({
                          ...current,
                          status: event.target.value as HistoryFilters["status"],
                        }))
                      }
                    >
                      <option value="all">All tasks</option>
                      <option value="open">Open</option>
                      <option value="completed">Completed</option>
                    </select>
                  </label>
                  <label>
                    Category
                    <select
                      value={historyFilters.categoryId}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({
                          ...current,
                          categoryId: event.target.value,
                        }))
                      }
                    >
                      <option value="">All categories</option>
                      {data.categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    From
                    <input
                      type="date"
                      value={historyFilters.from}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({ ...current, from: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Through
                    <input
                      type="date"
                      value={historyFilters.through}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({
                          ...current,
                          through: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <p className={styles.historyHint}>
                  {historyNextOffset === null
                    ? `Showing all ${historyTasks.length} available records.`
                    : `Showing ${historyTasks.length} loaded records. Filters search loaded records; load more to search farther back.`}
                </p>
                <TaskList
                  key={JSON.stringify(historyFilters)}
                  tasks={history}
                  categories={data.categories}
                  timezone={data.timezone}
                  now={now}
                  pending={pending}
                  onComplete={(id) => requestTaskCompletion([id])}
                  onCompleteMany={requestTaskCompletion}
                  onReopen={(id) => perform(() => reopenDashboardTask(id))}
                  onSave={editTask}
                  emptySearch={historyFilters.search}
                  emptyLabel="No matching history"
                  clearSearch={() => setHistoryFilters((current) => ({ ...current, search: "" }))}
                />
                {historyNextOffset !== null ? (
                  <div className={styles.historyMore}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={pending}
                      onClick={() => loadHistoryPage(historyNextOffset)}
                    >
                      {pending ? "Loading..." : "Load more records"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : view === "notes" ? (
              <div className={styles.historyView}>
                <NoteList
                  notes={notes}
                  categories={data.categories}
                  timezone={data.timezone}
                  pending={pending}
                  onSave={editNote}
                  onDelete={requestNoteDeletion}
                />
                {data.notesTruncated ? (
                  <div className={styles.historyMore}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={pending}
                      onClick={loadMoreNotes}
                    >
                      {pending ? "Loading..." : "Load older notes"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : view === "category" ? (
              <div className={styles.categoryContents}>
                <section>
                  <h2 className={styles.sectionHeading}>Tasks</h2>
                  <TaskList
                    key={`${view}:${categoryFilter}:${deferredSearch}`}
                    tasks={tasks}
                    categories={data.categories}
                    timezone={data.timezone}
                    now={now}
                    pending={pending}
                    onComplete={(id) => requestTaskCompletion([id])}
                    onCompleteMany={requestTaskCompletion}
                    onReopen={(id) => perform(() => reopenDashboardTask(id))}
                    onSave={editTask}
                    emptySearch={search}
                    emptyLabel="No active tasks in this category"
                    clearSearch={() => setSearch("")}
                  />
                </section>
                <section>
                  <h2 className={styles.sectionHeading}>Notes & ideas</h2>
                  <NoteList
                    notes={notes}
                    categories={data.categories}
                    timezone={data.timezone}
                    pending={pending}
                    onSave={editNote}
                    onDelete={requestNoteDeletion}
                  />
                  {data.notesTruncated ? (
                    <div className={styles.historyMore}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={pending}
                        onClick={loadMoreNotes}
                      >
                        {pending ? "Loading..." : "Load older notes"}
                      </button>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : isAssistant ? (
              <div className={styles.historyView}>
                <h2 className={styles.sectionHeading}>Next up</h2>
                <TaskList
                  tasks={tasks.slice(0, 5)}
                  categories={data.categories}
                  timezone={data.timezone}
                  now={now}
                  pending={pending}
                  onComplete={(id) => requestTaskCompletion([id])}
                  onCompleteMany={requestTaskCompletion}
                  onReopen={(id) => perform(() => reopenDashboardTask(id))}
                  onSave={editTask}
                  emptySearch=""
                  emptyLabel="No active tasks"
                  clearSearch={() => setSearch("")}
                />
                <p className={styles.limitNotice}>
                  Showing up to five upcoming tasks. Deadlines appear in Today and Week; study time
                  must be scheduled separately.
                </p>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => {
                      setSearch("");
                      setTaskFilter("all");
                      setView("tasks");
                    }}
                  >
                    View all tasks
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => {
                      setView("week");
                      moveWeek(weekStartOf(today));
                    }}
                  >
                    View this week
                  </button>
                </div>
              </div>
            ) : (
              <TaskList
                key={`${view}:${deferredSearch}:${taskFilter}`}
                tasks={tasks}
                categories={data.categories}
                timezone={data.timezone}
                now={now}
                pending={pending}
                onComplete={(id) => requestTaskCompletion([id])}
                onCompleteMany={requestTaskCompletion}
                onReopen={(id) => perform(() => reopenDashboardTask(id))}
                onSave={editTask}
                emptySearch={search}
                emptyLabel={view === "completed" ? "No completed tasks" : "No active tasks"}
                clearSearch={() => setSearch("")}
              />
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function CategorySelect({
  categories,
  name,
  value,
}: {
  categories: DashboardCategory[];
  name: string;
  value: string;
}) {
  return (
    <label>
      Category
      <select name={name} defaultValue={value} required>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TaskList({
  tasks,
  categories,
  timezone,
  now,
  pending,
  onComplete,
  onCompleteMany,
  onReopen,
  onSave,
  emptySearch,
  emptyLabel,
  clearSearch,
}: {
  tasks: DashboardTask[];
  categories: DashboardCategory[];
  timezone: string;
  now: Date;
  pending: boolean;
  onComplete: (id: string) => void;
  onCompleteMany: (ids: string[]) => void;
  onReopen: (id: string) => void;
  onSave: (id: string, form: HTMLFormElement, done: () => void) => void;
  emptySearch: string;
  emptyLabel: string;
  clearSearch: () => void;
}) {
  const [requestedPage, setRequestedPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = tasks.filter((task) => task.status === "open" && selectedIds.includes(task.id));
  const { items, page, pages } = taskPage(tasks, requestedPage);
  if (!tasks.length)
    return <EmptyState search={emptySearch} label={emptyLabel} clear={clearSearch} />;
  return (
    <>
      {tasks.some((task) => task.status === "open") ? (
        <div className={styles.selectionToolbar} role="group" aria-label="Task selection">
          <span>
            {selected.length} selected. Checkboxes select tasks; they do not mark them done.
          </span>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={pending}
            onClick={() =>
              setSelectedIds([
                ...new Set([
                  ...selectedIds,
                  ...items.filter((task) => task.status === "open").map((task) => task.id),
                ]),
              ])
            }
          >
            Select this page
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={pending || !selected.length}
            onClick={() => setSelectedIds([])}
          >
            Clear selection
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={pending || !selected.length}
            onClick={() => onCompleteMany(selected.map((task) => task.id))}
          >
            Mark selected done ({selected.length})
          </button>
        </div>
      ) : null}
      <ul className={styles.taskList}>
        {items.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            categories={categories}
            timezone={timezone}
            now={now}
            pending={pending}
            onComplete={onComplete}
            onReopen={onReopen}
            onSave={onSave}
            selected={selectedIds.includes(task.id)}
            onSelect={(id, checked) =>
              setSelectedIds((current) =>
                checked ? [...new Set([...current, id])] : current.filter((value) => value !== id),
              )
            }
          />
        ))}
      </ul>
      {pages > 1 ? (
        <nav className={styles.rowActions} aria-label="Task pages">
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={pending || page === 0}
            onClick={() => setRequestedPage(page - 1)}
          >
            Previous
          </button>
          <span role="status">
            Page {page + 1} of {pages}
          </span>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={pending || page === pages - 1}
            onClick={() => setRequestedPage(page + 1)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </>
  );
}

function TaskRow({
  task,
  categories,
  timezone,
  now,
  pending,
  onComplete,
  onReopen,
  onSave,
  selected,
  onSelect,
}: {
  task: DashboardTask;
  categories: DashboardCategory[];
  timezone: string;
  now: Date;
  pending: boolean;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onSave: (id: string, form: HTMLFormElement, done: () => void) => void;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const countdown =
    task.status === "open" && task.dueAt
      ? countdownLabel(task.dueAt, timezone, task.dueDateOnly, now)
      : null;
  const overdue = countdown?.startsWith("Overdue") ?? false;
  if (editing)
    return (
      <li className={styles.task}>
        <form
          className={styles.inlineEditor}
          onSubmit={(event) => {
            event.preventDefault();
            onSave(task.id, event.currentTarget, () => setEditing(false));
          }}
        >
          <input type="hidden" name="expectedVersion" value={task.version} />
          <label>
            Title
            <input name="title" required maxLength={300} defaultValue={task.title} />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue={task.priority}>
              <option value="minor">Minor</option>
              <option value="major">Major — extra advance reminders</option>
            </select>
          </label>
          <label>
            Due ({timezone})
            <input
              name="dueAt"
              type="datetime-local"
              defaultValue={dateTimeLocalValue(task.dueAt, timezone)}
            />
          </label>
          <label>
            Estimated minutes
            <input
              name="estimatedMinutes"
              type="number"
              min={1}
              max={100000}
              step={1}
              defaultValue={task.estimatedMinutes ?? ""}
            />
          </label>
          <CategorySelect categories={categories} name="categoryId" value={task.categoryId} />
          <label className={styles.inlineCheck}>
            <input name="dueDateOnly" type="checkbox" defaultChecked={task.dueDateOnly} />
            <span>
              No specific due time
              <small className={styles.checkHelp}>
                Use the selected date only. Leave unchecked for an exact deadline.
              </small>
            </span>
          </label>
          <label className={styles.fullWidth}>
            Details
            <textarea name="details" rows={3} maxLength={10000} defaultValue={task.details ?? ""} />
          </label>
          <div className={styles.rowActions}>
            <button className={styles.primaryButton} disabled={pending} type="submit">
              Save
            </button>
            <button
              className={styles.textButton}
              disabled={pending}
              type="button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  return (
    <li className={styles.task}>
      {task.status === "open" ? (
        <input
          className={styles.taskCheckbox}
          type="checkbox"
          disabled={pending}
          aria-label={`Select ${task.title}`}
          checked={selected}
          onChange={(event) => onSelect(task.id, event.target.checked)}
        />
      ) : (
        <span className={styles.completedMark} aria-label="Completed">
          <Check size={13} strokeWidth={3} aria-hidden="true" />
        </span>
      )}
      <div className={styles.taskContent}>
        <h2>{task.title}</h2>
        {task.details ? <p>{task.details}</p> : null}
        <div className={styles.taskMeta}>
          {task.archivedAt ? (
            <span className={styles.archivedTag}>
              Archived {formatDate(task.archivedAt, timezone)}
            </span>
          ) : null}
          {task.status === "completed" ? (
            <span className={styles.completedTag}>
              <CircleCheck size={13} aria-hidden="true" />
              Completed {formatDate(task.completedAt, timezone)}
            </span>
          ) : (
            <span className={overdue ? styles.overdue : styles.deadline}>
              <CalendarClock size={13} aria-hidden="true" />
              {formatDate(task.dueAt, timezone, task.dueDateOnly)}
            </span>
          )}
          {countdown ? <span className={styles.countdown}>{countdown}</span> : null}
          {task.status === "open" && task.reviewNote ? (
            <span className={styles.reviewTag}>
              <TriangleAlert size={13} aria-hidden="true" />
              Needs review: {task.reviewNote}
            </span>
          ) : null}
          {task.priority === "major" ? <span className={styles.majorTag}>Major</span> : null}
          {task.estimatedMinutes ? (
            <span>
              <Clock size={13} aria-hidden="true" />
              {task.estimatedMinutes} min
            </span>
          ) : null}
          {!task.dueAt && task.estimatedMinutes === null ? (
            <span className={styles.noteTag}>Just task</span>
          ) : null}
          <span>
            <Folder size={13} aria-hidden="true" />
            {categories.find((category) => category.id === task.categoryId)?.name ?? "Inbox"}
          </span>
        </div>
      </div>
      <div className={styles.rowActions}>
        {task.status === "open" ? (
          <button
            type="button"
            className={styles.textButton}
            disabled={pending}
            onClick={() => onComplete(task.id)}
          >
            <Check size={14} aria-hidden="true" /> Mark done
          </button>
        ) : null}
        <button
          type="button"
          className={styles.textButton}
          disabled={pending}
          onClick={() => setEditing(true)}
        >
          <Pencil size={14} aria-hidden="true" />
          Edit
        </button>
        {task.status === "completed" ? (
          <button
            type="button"
            className={styles.textButton}
            disabled={pending}
            onClick={() => onReopen(task.id)}
          >
            <Undo2 size={14} aria-hidden="true" />
            Reopen
          </button>
        ) : null}
      </div>
    </li>
  );
}

function NoteList({
  notes,
  categories,
  timezone,
  pending,
  onSave,
  onDelete,
}: {
  notes: DashboardNote[];
  categories: DashboardCategory[];
  timezone: string;
  pending: boolean;
  onSave: (id: string, form: HTMLFormElement, done: () => void) => void;
  onDelete: (id: string) => void;
}) {
  if (!notes.length) return <EmptyState search="" label="No saved notes" clear={() => {}} />;
  return (
    <ul className={styles.notesGrid}>
      {notes.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          categories={categories}
          timezone={timezone}
          pending={pending}
          onSave={onSave}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

function NoteCard({
  note,
  categories,
  timezone,
  pending,
  onSave,
  onDelete,
}: {
  note: DashboardNote;
  categories: DashboardCategory[];
  timezone: string;
  pending: boolean;
  onSave: (id: string, form: HTMLFormElement, done: () => void) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <li className={styles.note}>
        <form
          className={styles.inlineEditor}
          onSubmit={(event) => {
            event.preventDefault();
            onSave(note.id, event.currentTarget, () => setEditing(false));
          }}
        >
          <input type="hidden" name="expectedVersion" value={note.version} />
          <label>
            Title
            <input name="title" maxLength={300} defaultValue={note.title ?? ""} />
          </label>
          <CategorySelect categories={categories} name="categoryId" value={note.categoryId} />
          <fieldset className={styles.noteKinds}>
            <legend>Type</legend>
            <label>
              <input name="kind" type="radio" value="note" defaultChecked={note.kind === "note"} />
              Note
            </label>
            <label>
              <input name="kind" type="radio" value="idea" defaultChecked={note.kind === "idea"} />
              Idea
            </label>
          </fieldset>
          <label className={styles.fullWidth}>
            Thought
            <textarea
              className={styles.noteEditorBody}
              name="body"
              required
              rows={12}
              maxLength={50000}
              defaultValue={note.body}
            />
          </label>
          <div className={styles.rowActions}>
            <button className={styles.primaryButton} disabled={pending} type="submit">
              Save
            </button>
            <button
              className={styles.textButton}
              disabled={pending}
              type="button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  return (
    <li className={styles.note}>
      <div className={styles.noteMeta}>
        <span className={note.kind === "idea" ? styles.ideaTag : styles.noteTag}>
          {note.kind === "idea" ? (
            <Lightbulb size={12} aria-hidden="true" />
          ) : (
            <FileText size={12} aria-hidden="true" />
          )}
          {note.kind === "idea" ? "Idea" : "Note"}
        </span>
        <time dateTime={note.createdAt}>{formatDate(note.createdAt, timezone)}</time>
      </div>
      {note.title ? <h2>{note.title}</h2> : null}
      {note.kind === "idea" ? <IdeaBody body={note.body} /> : <p>{note.body}</p>}
      <div className={styles.noteFooter}>
        <span>
          {categories.find((category) => category.id === note.categoryId)?.name ?? "Inbox"}
        </span>
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.textButton}
            disabled={pending}
            onClick={() => onDelete(note.id)}
            aria-label={`Delete ${note.title ?? (note.kind === "idea" ? "idea" : "note")}`}
          >
            <Trash2 size={13} aria-hidden="true" /> Delete
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={pending}
            onClick={() => setEditing(true)}
          >
            <Pencil size={13} aria-hidden="true" />
            Edit
          </button>
        </div>
      </div>
    </li>
  );
}

function EmptyState({
  search,
  label,
  clear,
}: {
  search: string;
  label: string;
  clear: () => void;
}) {
  return (
    <div className={styles.empty}>
      {search ? <Search size={26} aria-hidden="true" /> : <Sparkles size={26} aria-hidden="true" />}
      <h2>{search ? "No matches" : label}</h2>
      {search ? (
        <button type="button" className={styles.secondaryButton} onClick={clear}>
          Clear search
        </button>
      ) : null}
    </div>
  );
}
