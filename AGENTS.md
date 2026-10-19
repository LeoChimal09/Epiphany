# Epiphany Project Instructions

Scope: this directory and its descendants. Do not modify neighboring projects
unless explicitly requested; they are references, not shared application state.

## Plan And Progress

- Read [README.md](README.md) for product requirements and [GOALS.md](GOALS.md)
  for the current goal. Do not start later goals without an explicit request.
- Follow [development practices](docs/standards/development-practices.md).
- Follow [operating policies](docs/operating-policies.md) for confirmations,
  conflicts, outages, conversation tests, retention, and spending safeguards.
- A runnable skeleton exists (Goal 02): see [local development](docs/local-development.md)
  for the commands that actually exist. Do not invent others or claim database,
  Discord, AI, calendar, deployment, or voice features already work.
- Record actual verification before checking off goals. Keep documentation and
  the next-goal pointer aligned with implemented behavior.

## Implementation

- Database schema, migration workflow, and recovery steps: [docs/database.md](docs/database.md).
- Access model (principals, permission matrix, confirmations, sign-in): [docs/security.md](docs/security.md).
  Personal data is read and changed only through `createServices`; never query the tables from a route.
- Use Bun for supported JS/TS dependencies and scripts; keep a single bun.lock.
- MySQL is the confirmed database choice. Use dedicated Epiphany credentials and
  versioned migrations; do not substitute SQLite or reuse a neighboring database.
- Do not choose a framework, database driver/ORM, or host by copying a reference
  project; record those decisions in Goal 01 first.
- Share domain services across dashboard, Discord, and voice. Validate AI actions
  and owner access before reading or changing personal records.
- User interactions are free-form conversation, not prefix/slash command matching.
  Explicit internal APIs, permission checks, and authorization flows are required.
- Prefer maintained libraries, small scoped edits, and nearby focused tests.
- If Next.js is selected, consult the installed version's relevant documentation;
  do not assume older APIs or overwrite framework-generated instruction blocks.

## Safety And Verification

- Never copy secrets, databases, personal logs, or MCP credentials from neighbors.
- Use disposable fixtures for destructive tests. Delete only exact records created
  by the test and verify cleanup by querying persisted state afterward.
- Do not apply destructive schema changes or db:push against real user data.
- Run the narrowest relevant check after edits, then the required goal/release gates.
  Disclose unavailable or unrun checks rather than claiming success.
- Never commit, push, create branches, or change git hooks without authorization.
  Preserve unrelated user changes; do not use destructive git resets or checkouts.