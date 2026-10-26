# Epiphany

Epiphany is a personal planning workspace. Epi is the conversational assistant
that helps keep it current through Discord, a React dashboard, and eventually
voice. This document records the product direction. The runnable skeleton and
first personal dashboard are in place ([local development](docs/local-development.md));
Discord conversation, AI planning, and calendar integrations remain future work.

## Product Goal

Talk to Epi like an assistant rather than maintaining several separate lists.
Epi organizes tasks from every area of life (school, work, fitness, errands, and
personal projects), events, notes, and reminders into one database and
reflects changes in Discord channels, the dashboard, and connected calendars.
The experience should support visual planning, frequent accountability, and
free-form conversation without hardcoded user commands, required prefixes, or
specific phrases to memorize.

## Discord Workspace

- On approved setup, create a dedicated category and channels in a chosen server.
- Reuse configured channels when setup runs again; do not create duplicates.
- Start with a private personal workspace and restrict access to the owner.
- Request only necessary permissions, including channel management for setup;
  do not require Administrator access.
- Support regular conversation in DMs and `#assistant`, without a prefix or
  mention on every message. Server message reading requires appropriate Message
  Content intent configuration.
- In other channels, respond to mentions, replies to Epi, or button interactions
  rather than treating every conversation as an instruction.
- Use conversational onboarding and settings changes rather than requiring slash
  commands or a command menu. Bot installation, account linking, and OAuth consent
  still use the appropriate Discord or dashboard authorization flows.
- Buttons and dashboard controls are optional conveniences, not prerequisites
  for asking Epi to perform an action through conversation.
- Check DM delivery during setup and report blocked DMs or missing permissions.
- Do not assume server-free user installation provides ordinary proactive bot DMs;
  verify current Discord capabilities before offering that installation mode.

| Channel | Purpose |
| --- | --- |
| `#assistant` | Natural conversation and requests affecting any part of Epiphany. |
| `#today` | Updated daily checklist, timeline, current plan, and available time. |
| `#schedule` | Weekly plans, fixed events, movable work blocks, and changes. |
| `#priorities` | Deadlines, countdowns, preparation dates, and next actions. |
| `#notes-and-ideas` | Epiphanies, notes, saved conversations, and transcripts. |
| `#check-ins` | Reminders, acknowledgment requests, and response buttons. |
| `#activity-log` | Completions, cancellations, rescheduling, and undo information. |

Keep overview messages updated rather than repeatedly posting full schedules.
Use threads for detailed assignment or idea discussions. Add separate workout,
sleep, or project channels only when they serve a useful distinct purpose.

## Natural Conversation And Auto-Sorting

- Accept messages such as "Finished chemistry" or "Move my workout to tomorrow."
- Interpret mixed, out-of-order messages and extract multiple independent items.
- Route information to the appropriate records and channel views automatically.
- Preserve the original conversation; sorting does not mean deleting or moving it.
- Recognize tasks, events, work blocks, notes, ideas, and casual conversation.
- Ask short follow-up questions when a task reference or requested change is unclear.
- Confirm clear changes briefly and support corrections and undo where practical.
- Honor "just chatting" and "do not save this" instructions for durable notes and
  tasks; separately define any temporary conversation retention policy.
- Use existing categories; new uncategorized items default to an Inbox.
- Tasks are not limited to school. Use flexible owner-created categories for
  work, gym, errands, personal projects, health routines, or anything else.
- Let the user recategorize naturally or through dashboard controls.
- Preserve recent conversational context and explicit preferences, but do not
  infer completion, attendance, or consent from silence.

Example: "Essay due Friday, remind me to start tomorrow, and save this app idea"
creates an assignment, proposes a reminder, and saves a separate idea. Missing
times or ambiguous dates require clarification rather than invented values.

### Free-Form Requests, Not Command Matching

- Interpret intent and context rather than matching a fixed list of phrases or
  requiring exact words. Examples in this document are illustrations, not syntax.
- Addressing the assistant as "Epi" is optional in DMs and `#assistant`; natural
  typed messages and supported voice transcripts use the same interpretation path.
- Support questions, informal language, multiple requests, and follow-ups such
  as "What about Thursday?" or "Let's do the shorter one first."
- Retrieve relevant current data, then use validated internal capabilities to
  read or update records. Internal APIs and permission rules remain explicit;
  the user does not need to know their names or invocation formats.
- Distinguish asking for advice from authorizing a change. Viewing a schedule or
  suggesting assignments must not silently create or move calendar events.
- Ask for missing information only when needed. If a request is unsupported or
  unclear, explain or clarify rather than pretending to have carried it out.

Example request: "Epi whats my schedule looking like this week, i want to see
what assignments i can crunch."

Epi should retrieve this week's events and work blocks in the user's timezone,
unfinished assignments and deadlines, and relevant effort estimates/preferences.
It should summarize usable time and suggest assignments to tackle based on
urgency, workload, and fit, flagging missing estimates or stale calendar data.
An illustrative reply is: "You have a gap Tuesday afternoon and another Thursday.
The worksheet is due first, so I'd start there. Want me to plan a work block?"
Actual dates, availability, and assignments must come from retrieved records.

The same planning should work for any mix of responsibilities: "I have two work
shifts, the gym, groceries, and a project deadline this week. What should I fit
in first?" Epi should combine those tasks and commitments rather than treating
non-school items as secondary or forcing them into an assignment category.

Success checks: differently worded requests can produce the same intended action;
the weekly-planning example works without a command or prefix; contextual follow-ups
resolve or trigger clarification; advice alone does not mutate the calendar.

### AI Use And Pasted-List Review

The assistant uses AI for uncertain language, not for every reply. Standalone greetings,
thanks, and simple approvals/rejections use fixed responses and the existing validated
action handlers, with no model call. These paths also work after the monthly AI budget
is exhausted. Additional instructions in the same message still go through interpretation.
Automatic Discord workspace setup, overview rendering, and scheduled reminder delivery
are also ordinary code, not generated announcements.

For interpreted turns, the OpenAI adapter now answers ordinary conversation as
natural text, not a required JSON action envelope. A single optional function call
requests a supported read or update, using only that action's arguments (including
sparse capture items). Idea feedback travels alongside the call, without repeating
it inside JSON. There is no automatic second model call, retry, or repair request.
Input caps include the system prompt, current context, and available function schemas;
usage-based cost estimates are recorded even when output is rejected.

Functions are proposals, not authorization: the server still validates arguments,
owner access, current records, no-save instructions, and required confirmations
through shared services. An invalid function never executes; useful conversational
text is retained with an explicit **update was not saved** warning. Invalid-only,
refused, and truncated replies report that nothing changed, rather than presenting
an outage or claiming success. Network/HTTP failures remain separately classified.
These paths are tested offline; live-model quality and token savings are not yet
measured against a deployed provider.

Multi-item captures now show a numbered preview before saving anything. Check the full
list, dates, categories, and review flags; approve it with a simple yes, or decline and
send a corrected version. Approval does not make another model call. Previews expire
after ten minutes and are cleared by unrelated conversation. Single-item captures and
explicit single-task creation keep their existing immediate-save behavior.

The original paste and source link are preserved when the approved tasks are saved.
Missing deadlines are flagged in code, existing categories are supplied to interpretation,
and same-title tasks with conflicting details are not silently discarded as duplicates.
Discord splits long previews into complete messages rather than truncating the items
being approved. This makes extraction reviewable; it does not guarantee that a model
understood every messy paste. Live-model evaluation is still required before deployment.

Complete repeated course cards (`title`, course code, `|`, `Go to course`, points,
deadline) are parsed in code before AI is used. Relative deadlines use the current
date in the owner's timezone; AM/PM times are converted without inventing a time.
These imports still require review and approval. Unsupported, incomplete, or ambiguous
formats go intact to language understanding rather than being partially imported.
For consistently numbered or bulleted lists, a visible entry count guards against
saving an extraction that contains fewer items than the list. Independent goals across
work, school, errands, and fitness are separate tasks, not one combined task.

### Developing An Idea Together

Saving an idea can include constructive feedback and a focused follow-up question in
the same model response; no second feedback call is made. As the owner contributes
features, concerns, problems, or goals, or asks to expand the brainstorm, Epi appends new bullet points to the same
idea instead of creating another note. The original body, title, category, and Idea
tag are preserved. Suggested directions should be labeled as suggestions, not owner
decisions; opinion-only and no-save discussion must not mutate the saved idea.

Points use flexible labels such as **Concern**, **Problem**, **Goal**, **Feature**,
or an owner-chosen title rather than a fixed label menu. Additions are grouped by the
owner's local date, with one heading per day instead of dates on each bullet. When
developing an older idea, the original content stays under its creation date and new
points use the day they were added. Date grouping and duplicate checks run in code,
without another model call. The idea card renders date groups and bold labels; its
editor retains an editable plain-text body. Existing ideas are not retroactively
rewritten or relabeled; grouping is added when they next receive saved points.
An idea is a concept to explore (such as a possible hosting migration); a note
holds reference information, while rotating keys is an actionable task/reminder.
A new reminder request without timing should get a timing question, not an
invented deadline or another copy of the active idea. The current message takes
priority over the previous brainstorm.

If a proposed new idea has a matching saved idea title, Epi asks whether to
develop that idea or save a separately titled idea instead of creating a second
card. Different content is explicitly called out, not silently dropped or
automatically appended. This check uses owner-scoped retrieved ideas (including
the active idea fetched fresh), not ordinary notes, and makes no success claim.
Existing duplicate cards are not automatically merged or deleted.

Idea details are collapsed by default in an accessible accordion, leaving the
title, creation timestamp, and Edit control visible. Expand "Idea details" to
read all dated sections and labeled bullets.

The active idea reference is owner-bound, and the body is re-read through shared services
for each interpreted turn. Only a bounded excerpt is sent to the model. Duplicate
points are skipped and concurrent edits cause a conflict response rather than an
overwrite. If the intended idea is unclear, Epi asks which one. Conversation-local
references reset when the conversation/runtime resets; the saved idea remains and
can be selected by title again. A request to return to an idea uses a read-only
resume action: it retrieves the saved body, shows a bounded recap, and sets that
idea as the active context for subsequent turns without adding invented bullets.
This restores saved idea context, not the full previous chat transcript.
Live-model feedback quality still needs verification.

## Personal Memory And Companion Experience

Epi should feel like a familiar personal assistant, not a new chatbot every time
the user opens a conversation. The dashboard and assistant share the same data;
the user should not need to explain their schedule or preferences repeatedly.
This familiarity comes from permissioned retrieval and persistent memory, not
from assuming that the AI model automatically learns or remembers everything.

- Link the dashboard account and Discord identity securely so Epi retrieves only
  the authenticated user's information, including when replying in voice.
- Retrieve relevant assignments, events, work blocks, priorities, notes, and
  preferences from the database before answering questions about them.
- Fetch current records for changing facts such as deadlines and completion;
  old conversation summaries must not override newer dashboard updates.
- Share memory across DMs, server assistant conversations, and dashboard/voice
  sessions while respecting the audience and privacy of each response.
- Maintain a personal profile for explicitly shared facts: preferred name,
  goals, courses, interests, routines, study preferences, and reminder style.
- Remember conversational context and relevant past decisions so follow-up
  requests such as "How about that idea from last week?" can retrieve saved notes.
- Separate short-term conversation context, durable personal preferences, and
  task/calendar records. Retrieve the relevant subset instead of sending the
  entire database or conversation history to the AI for every reply.
- Record where memories came from and when they were updated. Distinguish
  user-confirmed facts from uncertain interpretations and outdated information.
- Suggest patterns cautiously: "You often choose the gym after homework. Want
  me to remember that preference?" Do not silently turn observations into rules.
- Keep familiarity and tone configurable: supportive conversation, concise
  planning, or firmer accountability, without shaming or overriding user choices.
- Provide a dashboard memory/profile view and natural controls such as "What do
  you remember about me?", "Remember this", "That's no longer true", and
  "Forget that preference." Corrections should affect future retrieval.
- Define deletion across stored memories, summaries, and any search indexes;
  explain separately retained task history or logs rather than claiming all
  traces disappear when only one memory entry was removed.
- Honor no-save requests and require explicit consent before retaining sensitive
  personal details. Do not disclose private memories in shared channels.
- If retrieval fails or no relevant memory exists, say so and ask rather than
  inventing a personal history or pretending to know the current schedule.

Example: "What should I work on before the gym?" retrieves today's availability,
unfinished assignments, deadlines, and confirmed workout preferences. Epi can
then propose a realistic work block without asking the user to re-enter them.

Success checks: a dashboard deadline change appears in the next relevant reply;
a confirmed preference persists across sessions; a corrected or forgotten
preference is no longer used; another Discord user cannot retrieve the profile.

### Historical Records And Archived Assignments

An assignment completed a year ago should remain retrievable as history, not
reappear as unfinished work. Archiving removes clutter from active views; it
does not mean deleting the underlying record or forgetting that it happened.

- Retain completed assignment metadata and saved notes for long-term lookup,
  subject to the user's explicit deletion choices and disclosed retention policy.
  Record original deadlines, course/category, completion dates, and source links.
- Keep completion status separate from archive visibility. Age alone must not
  mark an unfinished assignment complete, cancel it, or silently delete it;
  offer a review of old unresolved tasks instead.
- Provide dashboard history search by title, course, category, date range, and
  status, with pagination rather than loading every past record at once.
- Support natural requests such as "What was that history assignment I finished
  last year?" Retrieve matching records and ask which one if several fit.
- Resolve relative dates using the user's timezone and clarify whether "last
  year" means the calendar year or academic year when that changes the results.
- Include historical context only when relevant to the request. Old deadlines
  must not generate reminders, reserve time, or influence today's unfinished list
  for completed tasks. Archived unfinished work follows its explicit active/
  paused reminder setting, not an assumption based on its age or visibility.
- Preserve known facts without inventing missing content: a saved assignment
  title does not mean Epi has its submitted answers, original file, or grade.
- Treat assignment records, conversation transcripts, and attachments as separate
  retention classes. A record can remain after raw audio or a transcript expires;
  explain unavailable details and expired/broken source links accurately.
- Let the user deliberately reopen a completed task or create a new follow-up,
  with a new plan as appropriate; recalling history alone must not reactivate it.
- Apply export, authorization, and deletion rules to archives and their search
  indexes too. Historical information must remain private and correctable.

Success checks: a year-old completed fixture is retrievable in chat and dashboard
history but absent from active reminders; an ambiguous historical query asks for
clarification; old unfinished work is not auto-completed; recalling an expired
attachment reports the limit without fabricating its contents.

### Behavior Awareness And Adaptive Support

Epi should gradually understand how the user tends to plan, work, take breaks,
and respond to accountability. The goal is more useful support, not a fixed
personality label or a claim to know what the user is doing at all times.

- With opt-in behavior tracking, use task updates, reminder replies, schedule
  changes, and voluntary check-ins as evidence. Do not silently monitor devices,
  games, location, or other private activity.
- Compare planned and reported actual task durations when start/end information
  is available; a completion timestamp alone does not establish time spent.
- Notice recurring postponements, early completions, preferred work windows,
  chosen break lengths, and which reminder styles receive useful responses.
- Ask about obstacles rather than assuming laziness: "This task has moved three
  times. Is it unclear, too large, or waiting on something?"
- Suggest smaller next steps, more realistic work blocks, earlier preparation,
  or a different check-in time based on relevant patterns.
- Learn preferences such as homework before gaming, gym after finishing work,
  or a bedtime wrap-up reminder from user feedback, not imposed assumptions.
- Keep observations separate from confirmed preferences. Record supporting
  evidence, recency, and uncertainty; avoid conclusions from a single incident
  and let old patterns lose relevance as routines change.
- Explain personalization: "You reported finishing similar worksheets in about
  45 minutes, so I suggested an hour with a buffer. Does that fit today?"
- Apply adaptations only within approved scheduling and notification settings;
  ask before increasing reminder limits or changing protected time.
- Let the user inspect, correct, dismiss, delete, or pause behavioral insights.
  Disabling tracking stops new observations; offer deletion of existing insights
  separately and honor the memory retention controls above.
- Treat silence as unknown and distinguish reported behavior from inference.
  Do not infer mood, medical conditions, or character flaws from productivity.

Example: "I keep getting caught up gaming past bedtime" can lead Epi to propose
an earlier wrap-up check-in. If the user agrees, Epi remembers that strategy and
asks later whether it helped, rather than claiming to detect gaming automatically.

Success checks: repeated reported durations improve a suggested estimate;
one missed reply does not become a behavioral conclusion; corrections override
inferences; adaptations stay within approved limits; paused tracking records no
new behavioral observations.

## Tasks, Commitments, And Scheduling

- Track any task, including homework, work responsibilities, workouts, errands,
  and personal projects. Store title, optional category/details/source, deadline,
  status, estimated effort, and remaining work where relevant.
- Keep categories owner-defined; School, Work, Fitness, Personal, and Errands are
  examples, not fixed categories or required fields.
- Parse pasted homework into a reviewable batch; flag uncertainty and duplicates.
- Keep tasks, fixed events, and movable work blocks as separate record types.
- Find usable time across calendars while respecting sleep, meals, travel,
  buffers, preferred study hours, and protected personal time.
- Suggest a daily/weekly plan and explain conflicts or insufficient time.
- Let the user choose how much automatic rescheduling is allowed.
- Completing a task clears its remaining future work blocks and active checklist
  entry, while retaining its deadline and completion history.
- Distinguish completed activities, canceled events, and postponed plans.
- Track major future priorities with countdowns and preparation milestones,
  not just a reminder on the due date.
- Support recurring workouts, bedtime routines, and other personal commitments.
- Offer catch-up work, the gym, or a break when work finishes early. Ask for the
  user's choice and duration; do not silently fill every free interval with work.

## Notifications And Accountability

- Morning briefing: today's tasks, events, priorities, and suggested work windows.
- Configurable event reminders, including a 30-minute "Still going?" check-in.
- Configurable hourly awareness reminders and current-activity check-ins.
- Deadline reminders that start early enough to allow preparation.
- Bedtime wind-down prompts and optional next-day sleep check-ins.
- Follow up on a chosen activity: "Still gaming, or ready to wrap up?"
- Support natural replies and buttons: Done, Still working, Snooze, Replan, Pause.
- Offer acknowledgment-required reminders with bounded follow-ups, not an
  unlimited notification loop or a claim that replies can literally be forced.
- Configure quiet hours, urgency levels, frequency, delivery channels, and limits.
- Send personal reminders to the private Discord `#check-ins` channel; Discord/device settings still
  control whether messages produce audible or push alerts.
- Treat no reply as unknown. Provide a way to pause accountability without penalty.
- Keep notifications persistent across service restarts, avoid duplicate sends,
  and handle failed delivery and overdue reminders deliberately.

## React Dashboard

Ask Epi for the website or dashboard link to receive the configured `APP_URL`
with `/dashboard`. Common link requests bypass AI calls; other phrasings can use
the website-link tool. Set `APP_URL` on the Discord worker as well as the website;
Epi reports missing configuration instead of guessing an address.

- Ask Epi shows at most five upcoming tasks, with links to all tasks and the current week.
- A header bell with a count opens a dismissible notification popover, keeping alerts
  out of the main page until requested. Idea descriptions use a full-width, vertically
  resizable editor with a larger initial height.
- Notifications show deadlines within one hour, due now and overdue, with explicit **Mark done**
  and **View task** controls and five-item paging. Timed countdowns show elapsed hours/minutes;
  date-only deadlines retain calendar-day labels. Silence never completes work.
  This area updates while the page is open; background Discord warnings require the separate
  worker. The existing persistent service defaults to 24-, 2- and 1-hour warnings unless an
  owner preference overrides them. See [reminders and limits](docs/reminders.md).
- Task lists show 20 loaded records per page. The initial snapshot includes up to 100
  tasks per status; Task history can load older records. Search filters loaded records.
- Task checkboxes select records only. Select one or more (or the current page), then
  choose Mark selected done and confirm the named tasks. Single-task Mark done and
  calendar/notification completion also require confirmation. Cancel does not complete
  anything; completed tasks remain in history.
- Notes and ideas have a Delete action with an explicit permanent-deletion warning.
  It uses the existing owner- and version-bound confirmation service (10-minute expiry);
  canceled or stale confirmations cannot delete the item. This is not a recoverable trash bin.
- Calendar combines Day, Week, and Month views in one navigation tab, with previous/next
  controls and a Today shortcut. Selecting a month cell opens that day's details.
- Account menu > Scheduling preferences provides separately saved, collapsed controls for
  preferred hours (multiple windows per weekday), sleep, meals, recurring protected time,
  event buffers, optional default travel before/after timed events, and minimum work blocks.
  Times use the configured owner timezone; a day with no preferred windows is unavailable.
  Sleep and protected time can cross midnight. Travel defaults start at zero and, if enabled,
  apply to every timed event (including online events); use specific protected time instead
  when travel only applies to some appointments. Defaults are not personal facts.
- Each calendar view includes a collapsed Availability and preparation panel. Free windows
  use the same deterministic planning engine and confirmed preferences as Epi, subtract
  scheduled events, travel, buffers, sleep, meals, protected time and planned work, and never
  offer elapsed time. No language-model calls are needed.
- Preparation milestones use loaded task deadlines and total effort estimates, subtract
  upcoming booked effort before the deadline, and suggest the latest feasible preparation
  start in the displayed range. Missing durations use a labeled 30-minute assumption;
  explicit estimates override it. Overdue work, conflicting blocks, and
  insufficient time are explicit. These are independent per-task suggestions, not reservations
  or a conflict-free multi-task plan; nothing is scheduled automatically.
- Availability is withheld when calendar records hit their loading limit. Pending, stale,
  failed, or expired Google sync makes displayed availability explicitly tentative; sync
  status is a snapshot from the last load. Only loaded tasks are considered for milestones;
  task-limit warnings and bounded window/deadline lists remain visible.
- Calendar views show task due dates as deadline markers, not automatically scheduled
  work sessions. When Google write access is connected, due-dated tasks sync to the
  dedicated Epiphany calendar (date-only deadlines as all-day events, timed deadlines
  as short markers); approved work blocks sync separately as planned work sessions.
- Calendar Day: timeline, checklist, current activity, and available time.
- Calendar Week/Month: visual calendar distinguishing fixed events from movable work blocks.
- Tasks combines general work and priorities: filter All tasks, With due date or
  duration, or Just tasks (neither). Due-date/countdown and duration labels remain
  visible on task rows; unplanned items show Just task. Filters work with search.
- Ideas: searchable notes, epiphanies, conversations explicitly saved, and transcripts.
- Inbox: review extracted homework, uncertain details, and uncategorized items.
- Settings: calendar access, categories, notification preferences, and voice options.
- Reflect Discord changes promptly, without requiring manual dashboard maintenance.
- Keep completed items out of active views but accessible in history.
- Support mobile use and make scheduling conflicts and sync failures visible.

## Google And Microsoft Calendars

- Connect Google Calendar through OAuth with explicit read/write permission choices.
- Prefer a dedicated Epiphany calendar for assistant-created work blocks and plans.
- Read existing calendars for availability; change existing appointments only when
  explicitly authorized. Avoid modifying shared meetings inadvertently.
- Investigate Microsoft Graph access to the Outlook/Exchange calendar behind Teams.
  School or employer policies may restrict consent or require administrator approval.
- Prefer a combined view of both calendars over copying everything into Google.
- Investigate read-only calendar subscriptions as a fallback where permitted;
  refresh delays make them unsuitable for guaranteed immediate synchronization.
- Track external event IDs, timezones, recurrence, and sync ownership to prevent
  duplicate events, sync loops, and accidental deletion of external records.
- Store OAuth tokens securely and allow disconnecting/revoking calendar access.

## Voice Roadmap: Talking To Epi

Voice is planned, not guaranteed by the initial text bot. Use "Epi" as the spoken
name; "Hey Epi" is a possible activation phrase, not an implemented wake word.

### Audio Messages

- Accept supported voice-message/audio attachments and transcribe them.
- Run transcripts through the same task, note, and scheduling logic as text.
- Generate optional spoken replies or reminders as playable audio attachments,
  with a text version available alongside them.
- Do not promise Discord's native voice-message format until bot API support is
  verified; ordinary supported audio attachments are the initial fallback.
- An audio message should not require joining a voice channel.

### Live Voice Conversation

- On an explicit request, join the user's server voice channel and speak as Epi.
- Listen, transcribe, interpret, and reply using speech synthesis.
- Use the same database and confirmation rules as text conversations.
- Support stop listening, mute spoken replies, leave, and idle auto-disconnect.
- Confirm uncertain or consequential calendar changes before applying them.
- Identify and authorize the speaker before accepting personal-data actions;
  do not let other channel participants access or change the owner's schedule.
- Make listening visible and require participant awareness/consent. Default to
  discarding raw audio after processing; saving transcripts should be configurable.
- Do not assume a bot can join a normal Discord DM/group call. Plan for server
  voice channels unless current supported APIs establish another option.

### Existing DiscordNPC Reference

The neighboring [DiscordNPC voice handler](../DiscordNPC/src/bot/voice/voice_handler.py)
contains a relevant implementation: server voice-channel join/leave, per-speaker
audio buffers, silence-triggered processing, Whisper transcription, ElevenLabs
speech synthesis with an OpenAI TTS fallback, and spoken playback. It also defines
an idle timeout and uses ffmpeg, libopus, and PyNaCl.

The implementation uses private discord.py internals and low-level voice packet
handling. Treat it as a reference, not a drop-in guarantee: check current Discord
voice encryption/protocol support and library compatibility before reuse. Prefer
a maintained compatible voice-receive library where possible. Its NPC routing and
game memory must be replaced with Epi's personal-assistant logic. Do not copy
DiscordNPC secrets, personal data, or environment files.

### Later Voice Options

- Dashboard push-to-talk for voice without joining Discord voice channels.
- Selectable Epi voice, speaking speed, and text-only/voice response preferences.
- Interruptible responses and improved turn-taking for live conversations.
- Investigate wake-word activation only within an explicitly enabled listening
  session, with privacy controls and realistic device/platform limitations.

## Data And Safety Principles

- A database is the source of truth; Discord and calendar views are projections.
- Store tasks, events, work blocks, categories, notes, preferences, conversation
  context, notification acknowledgments, and synchronization references separately.
- Record action provenance so corrections, history, and practical undo are possible.
- Deleting a Discord overview message must not delete the underlying assignment.
- Validate structured AI actions, permissions, dates, and conflicts before execution.
- Treat pasted homework and attachments as content, not privileged instructions.
- Keep credentials out of messages and logs; offer data export and deletion controls.
- Keep reliable scheduling and notifications in a background service; the dashboard
  does not need to remain open, but the deployed services must remain running.

### Database Decision: MySQL

Confirmed on 2026-10-13: use MySQL as Epiphany's shared source of truth for tasks,
schedules, notes, personal memory, and reminder state. Use a dedicated Epiphany
database and credentials, not DiscordNPC's database or data. The dashboard
accesses it through authenticated backend services, never browser credentials.

Goal 01 selected MySQL 8.4 LTS, Drizzle with mysql2, Docker for local setup, and
Railway hosting; see [the decision record](docs/decisions/0001-initial-architecture.md).
Use versioned migrations and plan automated independent
backups, verified restores, and data export for long-term use. A persistent volume
may store a self-hosted MySQL service's files, but it is not a replacement for the
database or a backup. Keep audio files in separate storage with database references.
This records the selection. Local Docker MySQL and the initial schema exist (see
[database](docs/database.md)); no hosted database has been provisioned yet.

## Operating Policies

Follow [Epi's operating policies](docs/operating-policies.md) for action permissions,
calendar conflicts, outage recovery, conversation acceptance tests, retention and
backup targets, and cost controls. These define planned behavior and completion
checks; numerical limits and recovery targets still require explicit decisions.

## Proposed Build Order

Use [the numbered build goals](GOALS.md) as the step-by-step execution checklist.
Each goal has a deliverable and completion criteria; the list below is the
high-level roadmap.

Follow [the development practices](docs/standards/development-practices.md),
adapted from existing projects. [Project instructions](AGENTS.md) guide future
implementation; tooling and CI become executable during the project skeleton goal.

1. Text foundation: database, owner access, Discord setup, ordinary conversation,
   manual tasks/notes, auto-sorting, and completion updates.
2. Daily planning: React dashboard, Google Calendar, usable-time rules, work blocks,
   morning briefings, deadlines, and two-way reminders.
3. Personal routines: workouts, sleep, acknowledgment follow-ups, preparation
   milestones, and configurable replanning after early completion.
4. Voice messages: incoming audio transcription and optional audio replies.
5. Live voice: compatibility-checked server voice conversations inspired by DiscordNPC.
6. Extensions: Microsoft calendar access, dashboard voice, and more adaptive planning.

## First-Version Success Checks

- One conversation can create an assignment and a separate idea in the correct views.
- "Finished that assignment" resolves context or asks which one, then updates all views.
- Finishing early releases work blocks without deleting deadline/completion history.
- A reminder reply updates the same records as a dashboard action.
- Setup and reminder processing do not create duplicates when retried.
- Ambiguous dates, blocked DMs, missing permissions, and calendar failures are visible.
- Personal information is inaccessible to unauthorized Discord users.

## Decisions Still Open

Decided in Goal 01 (see [the decision record](docs/decisions/0001-initial-architecture.md)):
Next.js dashboard, Bun/discord.js worker, Railway hosting, OpenAI for text, an
owner-only first release, America/Chicago, and the retention and budget defaults.

- Day boundaries, notification frequency, and quiet hours.
- Calendar replanning limits beyond the confirmation rules in the decision record.
- Transcription and speech providers, and voice budgets and retention.
- Whether school Microsoft calendar access is permitted.
- Whether a later release supports multiple users.