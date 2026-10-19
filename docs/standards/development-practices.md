# Development Practices

These standards adapt patterns from neighboring projects. The architecture is
recorded in [the decision record](../decisions/0001-initial-architecture.md).
The Goal 02 scripts and CI workflow exist (see [local development](../local-development.md));
migrations and deployment configuration remain requirements for later goals.

## Reference Patterns

- [DiscordNPC's Bun-first policy](../../../DiscordNPC/docs/standards/package-manager-policy.md)
  establishes install, script, and lockfile conventions.
- [discordtool's package scripts](../../../discordtool/package.json) illustrate
  lint/typecheck checks, tests, staged-secret checks, bot processes, and migrations.
- [discordtool's CI](../../../discordtool/.github/workflows/ci.yml) and
  [websterlocale's CI](../../../websterlocale/.github/workflows/ci.yml) illustrate
  Bun installation and check/build gates.
- [discordtool's secret guard](../../../discordtool/scripts/check-staged-secrets.mjs)
  is a reference for a future Epiphany-specific staged scanner.
- [DiscordNPC's deployment notes](../../../DiscordNPC/README.md) illustrate
  independently running a bot worker and database.

Sibling links are local references, not runtime dependencies. Do not copy their
credentials, data, provider settings, or project-specific integrations. The
AGENTS.md/CLAUDE.md reference arrangement follows neighboring projects; their
generated Next.js warnings apply only if that framework is chosen here.

## Package Management

- Default to Bun for supported JS/TS install, development, and scripts.
- Track one bun.lock per JS project; do not mix package-manager lockfiles.
- Pin the supported toolchain when scaffolding and use frozen-lockfile installs
  in CI. The committed lockfile must match the package manifest.
- Prefer direct tool invocations inside scripts; do not nest npm run commands.
- Keep Python tooling separate if a Python service is deliberately selected.

## Command Contract And CI

Goal 02 implemented the applicable contract below. `db:generate`, `db:migrate`,
and `db:status` arrive with Goal 03; `db:up`/`db:down` start the local MySQL container.
The CI workflow is written but has not run on a hosted runner (no repository yet).

| Script | Required purpose |
| --- | --- |
| `dev` | Start local dashboard development. |
| `bot:dev` / `bot:start` | Run the bot/worker independently when using JS/TS. |
| `lint` | Lint with no accepted warnings. |
| `typecheck` | Check types without emitting production artifacts. |
| `check` | Run lint and typecheck. |
| `test:run` | Run automated tests once, without watch mode. |
| `build` | Build deployable artifacts. |
| `security:staged` | Inspect staged changes for likely secrets without printing values. |
| `precommit:check` | Run check and the staged-secret guard; never perform a commit. |

CI should install with Bun's frozen lockfile, run check, run noninteractive tests,
and build. Include tests even where reference workflows currently omit them.
Use isolated service fixtures and no production credentials. Document necessary
build-time configuration rather than bypassing type errors or lint failures.
Do not install git hooks or change git configuration automatically during install.

## Shared Services And Database Changes

- Keep persistence and domain decisions in shared backend services/repositories,
  not separate implementations inside dashboard, bot, and voice handlers.
- MySQL 8.4 LTS with Drizzle ORM and mysql2 was selected in Goal 01; use a dedicated
  database and credentials, with no browser-side database access.
- Use schema-as-code and versioned migrations with Drizzle. The dashboard framework
  is Next.js; follow the framework guidance in AGENTS.md when scaffolding.
- When applicable, implement db:generate and db:migrate. Restrict any db:push
  convenience to explicitly disposable prototypes; it is not a deployment path.
- Test migrations on a clean database and upgrades against isolated fixtures.
- Use stable IDs and idempotent writes for calendar synchronization, reminders,
  and retryable Discord setup. Verify actual persisted state after mutations.
- Keep schema changes and migrations together; require approval and backups
  before destructive changes to real data.

### Required Migration Workflow

Every persistent schema change must ship with a reviewed, versioned migration,
including changes introduced during later feature goals. These requirements
become executable in Goal 03; no migration tooling is installed yet.

1. Update the schema definition, generate or write a new migration, and review
  the resulting SQL. Commit schema and migration artifacts together only when
  a commit is authorized; never rewrite a migration already applied to a shared
  environment. Add a new corrective migration instead.
2. Prefer additive, backward-compatible changes. For renames, type changes, or
  new required fields, plan staged backfills and application compatibility before
  removing old fields or adding constraints to existing records.
3. Test clean installation and upgrade from the previous schema using isolated
  MySQL fixtures containing representative tasks, notes, and preferences. Verify
  data preservation, expected constraints, and a second run with no pending changes.
4. Apply only pending migrations in order using a migration-history table and a
  single serialized migration runner. Coordinate deployment so concurrent
  dashboard/bot instances cannot race to apply the same migration.
5. Before production changes, confirm the target environment, migration status,
  relevant backup/restore readiness, and approval for destructive operations.
  Run an explicit deployment migration step; never reset or recreate the database
  just to make a schema update succeed.
6. Stop rollout on failure and inspect both migration history and actual schema.
  Many MySQL DDL operations implicitly commit, so do not assume transaction
  rollback restores a partially changed schema. Document a tested recovery or
  forward-fix plan; do not blindly retry partially applied SQL.

Provide documented db:generate, db:migrate, and db:status script equivalents for
the chosen migration tool. Routine application restarts must not recreate tables
or perform unreviewed schema synchronization. CI validates migrations on disposable
MySQL databases, never applies them to production, and fails on missing artifacts
for schema changes using checks supported by the selected toolchain.

## Security And Test Data

- Environment examples contain placeholders only. Local tokens, OAuth secrets,
  raw recordings, database files, and private logs must not be tracked.
- .gitignore is a preventive default, not a secret scanner or encryption layer.
  Configure private storage under ignored paths when implementation begins.
- Adapt the staged-secret guard to Discord, AI-provider, and Google/Microsoft
  OAuth credentials; redact matches. Test it with unmistakably synthetic values
  in isolated temporary git fixtures, not by staging live credentials.
- Never read or copy neighboring .env files or MCP credential configurations.
  Inspect tool configuration only when needed and without exposing secret values.
- Test deletion and cleanup only on disposable fixtures or exact records created
  during the test. Re-query to verify cleanup; never clear an existing user's list.
- Verify cross-user denial, shared-channel privacy, and permission checks around
  every AI-triggered personal-data action.

## Deployment And Operations

- Railway is the selected host (Goal 01); nothing is provisioned yet. Keep dashboard
  and persistent bot/reminder worker lifecycles explicit and separate.
- Ensure background jobs do not depend on a browser tab or short-lived web request.
- Configure runtime secrets through the chosen host, not committed environment files.
- Add health checks, graceful shutdown, useful redacted logs, migration procedure,
  restart recovery, and verified backups/restore before the first release gate.
- Pin relevant runtime dependencies and document voice system requirements when
  voice goals begin. Do not blindly copy private Discord library internals.

## Documentation And Completion

- README.md describes the product; GOALS.md tracks ordered implementation.
- Record architecture choices and required accounts/blockers in Goal 01.
- Record completed goals with date, changed implementation, checks run, results,
  and limitations. Keep speculative features labeled as planned.
- Run focused checks after each implementation slice; run full applicable gates
  at goal completion and release. Document blocked checks honestly.
- For the current documentation-only stage, verify links, checklist structure,
  and ignore-rule behavior; do not claim an application build or tests passed.