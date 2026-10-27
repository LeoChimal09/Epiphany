# Reminders, briefings, and routines

The reminder service runs in the `worker` and uses **no AI call**, so reminders keep working when the
model provider is down. It mentions the owner in their private Epiphany `#check-ins` channel to
trigger a Discord notification. It never falls back to a public channel or DM.

## How it works

- **Persistent jobs.** Every reminder is a row in `reminders` with a status: `scheduled`, `sending`,
  `sent`, `skipped`, `failed`, `unknown`, or `canceled`. A restart loses nothing.
- **No duplicates.** Every job has a dedupe key built from what it is about and when (for example
  `task:<id>:lead24h:<deadline>`), so scheduling can run every 15 seconds and create only what is new.
  Missed lead times are canceled instead of replayed; if a timed task is created too close for any
  configured lead, one immediate reminder replaces those missed warnings. When several task alerts
  become due together, only the newest one is sent. If a deadline moves, old jobs are canceled and new
  ones created. Finished tasks and canceled events have their pending jobs canceled.
- **Sent at most once.** A job is *claimed* with a conditional update before it is sent, so two workers
  cannot both send it. If the worker dies after claiming and before recording the result, the job is
  marked `unknown` ("delivery not confirmed; not resent") rather than sent again, because it may already
  have arrived. **Delivery is therefore at-most-once; in that crash window a reminder can be lost, never
  doubled.** It is shown under "Didn't reach you" in `#check-ins`.
- **Retries.** A failed send is retried after 1, 5, then 15 minutes (a rate-limit answer that asks for
  longer is honored) up to 4 tries, then marked `failed` with the reason. If there is no private
  `#check-ins` destination, it will not post to a public channel or fall back to DMs.

## What is still worth sending

Decided in one place (`packages/core/src/reminders/policy.ts`), in this order:

1. Paused (see below): skipped.
2. The task is done or archived, or the event is canceled or over: skipped as obsolete.
3. Too late to matter: skipped as stale. A deadline or custom reminder stays worth sending for **24
   hours**; a morning briefing for **3 hours**; an event reminder, check-in, or wind-down for **30
   minutes**. After an outage the owner gets what still matters, not every missed hourly prompt.
4. Quiet hours (10 PM–7 AM local by default): an ordinary reminder is held until they end, unless that would make it
   stale, in which case it is dropped. Urgent reminders go through.
5. Daily limit (12 ordinary reminders a day by default): extras are skipped.
6. Late but relevant: sent with "(a little late)". If more than 3 unrelated reminders are late at once,
   they are merged into one short summary.

## Defaults and where to change them

These defaults were chosen for Goal 15 and are the owner's to change, by simply saying so in
conversation ("don't ping me between 10pm and 7am", "brief me at 7:30", "bedtime is 10:30") or
from **Dashboard → Scheduling preferences → Morning briefing**. Enter the time in AM/PM; it uses
the owner's configured timezone. Delivery can also be turned off:

| Setting (preference key)             | Default            |
| ------------------------------------ | ------------------ |
| `reminders.quiet_hours`              | 22:00–07:00 local  |
| `reminders.briefing_time`            | 08:00              |
| `reminders.daily_limit`              | 12 (raising it asks first) |
| `reminders.event_lead_minutes`       | 30                 |
| `reminders.deadline_lead_hours`      | 1 hour before           |
| `routine.bedtime`                    | off                |
| `routine.workout`                    | off                |
| `routine.awareness` (hourly prompts) | off                |

The morning briefing defaults to 08:00 local time. Change its delivery time from the dashboard or
in conversation; pending briefings are moved to the new time. If today's briefing was already sent,
the new time applies to the next scheduled briefing. Uncheck **Send morning briefing** in the
dashboard to disable delivery.

One-time requests such as "remind me at 2 PM to go grocery shopping" notify at 1:30 PM, 30 minutes
before the stated target. If the target is less than 30 minutes away, the reminder is sent as soon
as possible. Use a task with a due date instead when the work should remain on the task list.

Date-only task deadlines are reminded at 9 AM on the local days covered by the configured lead
times, with multiple leads on the same day combined into one reminder. Same-day meetings retain
their 30-minute warning; all-day events get one reminder at 9 AM local time (or immediately if first
noticed later that day).

Tasks can be marked **minor** or **major**. Minor is always the default and gets the configured
deadline reminder (one hour ahead by default). Major deadlines retain their existing 14-, 7-, and
3-day advance reminders plus their configured closer deadline reminders. Epi only sets major when
the owner explicitly asks for major/high priority or extra advance reminders. Exams and other
high-stakes tasks are not automatically promoted. These alerts remain ordinary reminders: quiet
hours (10 PM–7 AM), pause settings, and the daily limit still apply. A morning briefing is separate
and does not control deadline alerts.

The one-hour warning is included for owners without a confirmed lead-time preference.
An existing confirmed preference replaces the defaults; it is not silently expanded.
The extra default warning still respects pause, quiet hours and the same daily limit;
it is not a guarantee of delivery exactly one hour before the deadline. The Discord
gateway starts the existing persistent reminder runner as soon as Discord is ready, before server
setup completes, and polls every 15 seconds. No second queue or AI call is involved.

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
while the dashboard is closed. Background deadline alerts use the separate worker and
the existing persistent lead-time reminders above. There is no new looping overdue-DM
escalation or automatic completion; dashboard overdue items remain actionable even
after Discord catch-up limits have elapsed. Delivery and dashboard controls make no
model calls; conversational replies still use the existing assistant interpretation path.

## Briefing, check-ins, and replies

- The **morning briefing** is built from today's records at the moment it is sent, not when it was
  scheduled.
- Event reminders come 30 minutes before, plus a "Still going?" check 30 minutes after the start.
- **Reply naturally** in the private `#check-ins` channel: "finished it" completes the task it was about,
  "snooze" (or "give me an hour") puts it off, "not going" cancels the event it was about. Epi understands
  these because the channel conversation remembers which reminder was just sent.
- **No reply is unknown**, not a conclusion: nothing is inferred from silence, and a reminder is never
  repeated in a loop.
- "Pause reminders" (optionally "for two hours") stops them without penalty; "bring them back" resumes
  them. Nothing missed during a pause is replayed.
- "I'm gaming for an hour" schedules the agreed check-in ("Still going, or ready to wrap up?").
- Finishing a task more than a day early offers choices: catch-up work, a workout, or a break.
- Discord Done / Snooze / Replan **buttons are not built**; replies work in plain words.
  The dashboard's notification **Mark done** button is implemented.

## Limits

- Reminders require Epi's private workspace `#check-ins` channel; Discord/device notification settings
  determine whether a new channel message makes a sound or push notification.
- Reminders are tied to the worker being up; they are not sent while it is down, and after an outage only
  what still matters is sent.
