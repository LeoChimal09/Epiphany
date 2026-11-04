# Epiphany

**A conversational planning workspace for tasks, time, and everyday routines.**

Epi connects a private dashboard and Discord assistant to the same planning records.
Describe what needs doing, review your schedule, and update plans in ordinary language
instead of maintaining separate lists or memorizing commands.

## What it does

- **Capture and organize:** tasks, simple to-dos, notes, ideas, categories, and reviewable
  imports from pasted assignment lists.
- **Plan visually:** day, week, and month calendars with deadlines, appointments,
  work blocks, and availability based on routines and existing commitments.
- **Keep plans current:** complete or cancel work without deleting history, move existing
  work blocks, and preview a single event occurrence's time change before confirming.
- **Stay accountable:** persistent Discord reminders, morning briefings, snoozing,
  quiet hours, and optional split-day check-ins.
- **Connect Google Calendar:** import selected calendars and mirror Epiphany-owned
  events, work blocks, and deadlines to a dedicated calendar. External changes are
  treated as conflicts, not silently overwritten.
- **Personalize deliberately:** opt-in learning from reported durations and snoozes,
  occasional optional questions, evidence-backed estimates, and approved preferences.
  No learning from silence.

Examples of conversation, not required syntax:

> "What's free on Thursday?"
>
> "Move my chemistry work block to tomorrow at four."
>
> "I finished the lab report."

## Architecture

| Layer | Technology |
| --- | --- |
| Dashboard and server API | Next.js, React, TypeScript |
| Discord and background jobs | Bun, discord.js |
| Shared authorization and domain services | `packages/core` |
| Persistence | MySQL 8.4, Drizzle ORM, versioned migrations |
| Natural-language interpretation | OpenAI tool calling with server-side validation |
| Calendar integration | Google Calendar API |

Both interfaces use the same permissioned services. Consequential actions use
owner- and version-bound confirmations; providers cannot authorize writes.
Reminder delivery does not require a new AI call, and spending limits gate optional AI use.

## Run locally

Requires **Bun 1.3.14**, **Node 24+**, and Docker for local MySQL.

```sh
bun install --frozen-lockfile
cp .env.example .env
# Configure DATABASE_URL and owner/sign-in settings; see the setup guides below.
bun run db:up
bun run db:migrate
bun run dev
```

In another terminal, run `bun run bot:dev` for Discord and background jobs.
Configure integrations only when using them; never commit `.env` or provider credentials.

- [Local development and checks](docs/local-development.md)
- [Discord setup](docs/discord.md)
- [Google Calendar setup and sync behavior](docs/calendar.md)
- [Database, migrations, and recovery](docs/database.md)
- [Deployment and operations](docs/operations.md)

## Quality and status

This is an actively developed, **owner-only** application, not a public multi-user service.
Implemented code is not a claim that every hosted/provider integration has passed live
acceptance. Microsoft Calendar and broader adaptive planning remain unfinished;
voice capabilities are optional and have separate setup and verification requirements.

```sh
bun run check
bun run test:run
bun run build
```

Database-backed tests require the disposable MySQL test server and `TEST_MYSQL_ADMIN_URL`;
without it those tests are skipped. See [local development](docs/local-development.md).
The [build goals](GOALS.md) record actual verification and outstanding gates.

## Design and roadmap

The focus is a dependable personal assistant: explicit intent before scheduling,
no invented deadlines, preserved history, and honest reporting of pending external sync.

See the [product plan](docs/product-plan.md), [architecture decisions](docs/decisions/0001-initial-architecture.md),
[access model](docs/security.md), and [operating policies](docs/operating-policies.md).
