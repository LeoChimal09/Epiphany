# Reminders, briefings, and routines

The reminder service runs in the `worker` and uses **no AI call**, so reminders keep working when the
model provider is down. It delivers by DM to the owner.

## How it works

- **Persistent jobs.** Every reminder is a row in `reminders` with a status: `scheduled`, `sending`,
  `sent`, `skipped`, `failed`, `unknown`, or `canceled`. A restart loses nothing.
- **No duplicates.** Every job has a dedupe key built from what it is about and when (for example
  `task:<id>:lead24h:<deadline>`), so scheduling can run every 30 seconds and create only what is new.
  If a deadline moves, the old jobs are canceled and new ones created. Finished tasks and canceled events
  have their pending jobs canceled.
- **Sent at most once.** A job is *claimed* with a conditional update before it is sent, so two workers
  cannot both send it. If the worker dies after claiming and before recording the result, the job is
  marked `unknown` ("delivery not confirmed; not resent") rather than sent again, because it may already
  have arrived. **Delivery is therefore at-most-once; in that crash window a reminder can be lost, never
  doubled.** It is shown under "Didn't reach you" in `#check-ins`.
- **Retries.** A failed send is retried after 1, 5, then 15 minutes (a rate-limit answer that asks for
  longer is honored) up to 4 tries, then marked `failed` with the reason. Blocked DMs (the owner's DMs
  from server members are off) are not retried: they are marked `failed` and shown in `#check-ins`.

## What is still worth sending

Decided in one place (`packages/core/src/reminders/policy.ts`), in this order:

1. Paused (see below): skipped.
2. The task is done or archived, or the event is canceled or over: skipped as obsolete.
3. Too late to matter: skipped as stale. A deadline or custom reminder stays worth sending for **24
   hours**; a morning briefing for **3 hours**; an event reminder, check-in, or wind-down for **30
   minutes**. After an outage the owner gets what still matters, not every missed hourly prompt.
4. Quiet hours (none until set): an ordinary reminder is held until they end, unless that would make it
   stale, in which case it is dropped. Urgent reminders go through.
5. Daily limit (12 ordinary reminders a day by default): extras are skipped.
6. Late but relevant: sent with "(a little late)". If more than 3 are late at once, they are merged into
   one short summary.

## Defaults and where to change them

These defaults were chosen for Goal 15 and are the owner's to change, by simply saying so in
conversation ("don't ping me between 10pm and 7am", "brief me at 7:30", "bedtime is 10:30"):

| Setting (preference key)             | Default            |
| ------------------------------------ | ------------------ |
| `reminders.quiet_hours`              | none               |
| `reminders.briefing_time`            | 08:00              |
| `reminders.daily_limit`              | 12 (raising it asks first) |
| `reminders.event_lead_minutes`       | 30                 |
| `reminders.deadline_lead_hours`      | 24, 2 and 1 hour before |
| `routine.bedtime`                    | off                |
| `routine.workout`                    | off                |
| `routine.awareness` (hourly prompts) | off                |

The one-hour warning is included for owners without a confirmed lead-time preference.
An existing confirmed preference replaces the defaults; it is not silently expanded.
The extra default warning still respects pause, quiet hours and the same daily limit;
it is not a guarantee of delivery exactly one hour before the deadline. The Discord
gateway starts the existing persistent reminder runner on ready and polls every 30 seconds.
No second queue or AI call is involved.

## Dashboard notification area

The dashboard has a dedicated **Notifications** area in every view, derived from its
authorized, loaded task records. It shows timed deadlines with **60 minutes or less**
remaining, **Due now** at the deadline, and overdue work until explicitly completed.
Timed countdowns use elapsed days/hours/minutes rather than calendar-day differences:
an October 21, 11:59 PM Chicago deadline at October 22, 8:40 AM is **Overdue 8 hours
41 minutes**, not one day. Date-only deadlines remain **Due today** throughout the
owner-local due day, becoming overdue the following day; no time is invented.

Each notification offers **Mark done**, through the same authorized persisted task
completion action used elsewhere, and **View task** for details/editing. Silence
never completes or dismisses work. Completed/archived tasks are excluded. Five items
are shown at a time with Previous/Next navigation; due-now and due-soon warnings come
before overdue backlogs. The initial 100-open-task limit is
disclosed when reached, with access to paginated **Task history** for all records.
No notification-specific persistence is needed: reloading derives the list again
from saved task state, and completed tasks remain in history.

The page updates its clock every minute and refreshes records every 30 seconds while
visible (also on return to the tab). This is **not browser push** and cannot notify
while the dashboard is closed. Background deadline DMs use the separate worker and
the existing persistent lead-time reminders above. There is no new looping overdue-DM
escalation or automatic completion; dashboard overdue items remain actionable even
after Discord catch-up limits have elapsed. Delivery and dashboard controls make no
model calls; conversational replies still use the existing assistant interpretation path.

## Briefing, check-ins, and replies

- The **morning briefing** is built from today's records at the moment it is sent, not when it was
  scheduled.
- Event reminders come 30 minutes before, plus a "Still going?" check 30 minutes after the start.
- **Reply naturally** to a reminder DM: "finished it" completes the task it was about, "snooze" (or "give
  me an hour") puts it off, "not going" cancels the event it was about. Epi understands these because the
  DM conversation remembers which reminder was just sent.
- **No reply is unknown**, not a conclusion: nothing is inferred from silence, and a reminder is never
  repeated in a loop.
- "Pause reminders" (optionally "for two hours") stops them without penalty; "bring them back" resumes
  them. Nothing missed during a pause is replayed.
- "I'm gaming for an hour" schedules the agreed check-in ("Still going, or ready to wrap up?").
- Finishing a task more than a day early offers choices: catch-up work, a workout, or a break.
- Discord Done / Snooze / Replan **buttons are not built**; replies work in plain words.
  The dashboard's notification **Mark done** button is implemented.

## Limits

- Background delivery is by DM only; Discord and device settings decide whether a DM makes a sound or a push.
- Reminders are tied to the worker being up; they are not sent while it is down, and after an outage only
  what still matters is sent.
