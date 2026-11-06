# Local Development

The dashboard and background worker share SQLite through the same domain services.
See [database](database.md) for migrations/import and [operations](operations.md)
for the single-service Railway deployment. Hosted acceptance remains separate
from local tests.

## Requirements

- Bun 1.3.14 (pinned in `.bun-version` and `package.json`) and Node 24 or newer
  (`.node-version`). Next.js and ESLint run on Node; the worker runs on Bun.
- No database server or Docker is needed for normal SQLite development.
  Docker is optional for testing the production image; legacy MySQL source
  access is only needed for a deliberate data import.

## Setup

```sh
bun install --frozen-lockfile
cp .env.example .env
mkdir -p data
# DATABASE_URL=file:./data/epiphany.sqlite in .env
bun run db:migrate
```

`.env` is ignored by git and shared by the dashboard and worker. Keep the example's
`DATABASE_URL=file:./data/epiphany.sqlite` and run commands from the repository root,
or use an absolute file URL for a dedicated local directory. The directory must exist
and be writable. SQLite database files and WAL/SHM sidecars under `data` are ignored;
never commit or copy personal databases into fixtures. Do not use `:memory:` or a
remote libSQL endpoint for the production launcher. `DATABASE_URL` is required;
missing/invalid configuration fails startup without printing its value.

Both runtimes must use the same local file on the same machine. Do not share it
through a network drive, point development at a production volume, or start old
MySQL writers during an import. Local MySQL Compose files, where retained for
historical tooling, are not required for the SQLite application.

## Dashboard sign-in

The dashboard requires signing in with Discord, and only the account in `OWNER_DISCORD_USER_ID` is
accepted. Until `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `OWNER_DISCORD_USER_ID`, and `APP_URL`
are set, the dashboard stays locked and the login page says sign-in is not set up. Setup steps are in
[security](security.md#set-up-sign-in).

### Behind a company proxy (TLS inspection)

If sign-in returns to the login page with "temporarily unavailable" and the dev server log shows
`sign_in_failed` with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, your network re-signs HTTPS traffic with a
company certificate that the browser trusts (Windows installed it) but WSL, Node, Bun, and curl do not.
Check with: `echo | openssl s_client -connect discord.com:443 -servername discord.com 2>/dev/null | openssl x509 -noout -issuer`
(an issuer that is your company's proxy confirms it). Options:

1. **Development bypass (simplest).** Set `ENV_BYPASS="dev"` in `.env`, restart `bun run dev`, and use
   "Continue as dev owner". See [security](security.md#development-bypass-env_bypassdev).
2. **Trust the company root certificate for this app.** Export your company's *root* CA from Windows
   (Certificate Manager > Trusted Root Certification Authorities > export as Base-64 `.cer`), save it
   outside the repository (for example `~/certs/company-root.pem`), and start the server with
   `NODE_EXTRA_CA_CERTS=~/certs/company-root.pem bun run dev`. It must be set in the shell, not in
   `.env`, because Node reads it at startup. This keeps normal certificate checking for everything
   else. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Note that a TLS-inspecting proxy can read decrypted traffic to Discord, including the OAuth client
secret and tokens, and your employer may have rules about personal projects on its network. Discord's
bot connection (Goal 06) and voice (Goal 22) will face the same inspection.

## Running

| Command                           | Purpose                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `bun run dev`                     | Dashboard at http://localhost:3000 (binds to localhost loopback only); health at `/api/health`. |
| `bun run bot:dev`                 | Worker with file watching; health at http://localhost:3001/health. |
| `bun run bot:start`               | Worker without watching.                                         |
| `bun run build` / `bun run start` | Production build, then supervisor: migrate, start Node web + Bun worker. |
| `bun run web:start`              | Web only, after an explicit `db:migrate` (no worker or supervision). |
| `bun run db:migrate` / `db:status` | Apply or inspect migrations; see [database](database.md).        |

Health responses report configuration only; database connectivity is still reported as
`not_checked`, not an end-to-end readiness assertion. Stop development processes with
Ctrl+C. For production-style local verification, stop both development processes first,
build, and run `bun run start`. The supervisor defaults to web 3000/worker 3001, rejects
port collisions, migrates before either child starts, and shuts down both on Ctrl+C,
SIGTERM, or either child's unexpected exit. Optional provider credentials can be omitted
to test configuration-only/health behavior; that does not verify a connected Discord bot.

## Checks

| Command                     | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `bun run lint`              | ESLint with no accepted warnings.                                    |
| `bun run format:check`      | Prettier check for code and config (Markdown is not formatted).      |
| `bun run typecheck`         | `tsc --noEmit` for the root projects and the dashboard.              |
| `bun run check`             | Lint, format check, and typecheck.                                   |
| `bun run test:run`          | Vitest once; SQLite fixtures must be isolated from the application database. See [database](database.md) for database test requirements. |
| `bun run db:check`          | Fail if schema and migrations disagree.                              |
| `bun run security:staged`   | Scan staged git changes for likely secrets; prints no values.        |
| `bun run precommit:check`   | `check` plus migration drift and the staged-secret scan. It never commits. |

`bun run format` rewrites files with Prettier. No git hooks are installed; run
`precommit:check` yourself when you choose to commit.
Lint and formatting ignore generated Next.js output (`.next`, `.next-*`, and
`build-ci`), including isolated production/release-gate builds. The release gate
uses the same lint script as the precommit checks.
Historical MySQL integration/restore tools are not proof of SQLite behavior.
Run the current SQLite migration and storage checks before accepting a cutover;
report any skipped legacy/provider tests honestly.

The staged-secret scan recognizes Discord, OpenAI, Google, and Microsoft credential
shapes, private keys, secret-named assignments, MySQL URLs with real passwords, and
staged environment, key, audio, and database files. It is a safety net, not a
guarantee: it cannot find every secret.

## Layout

```text
apps/web        Next.js dashboard and API routes (see apps/web/AGENTS.md)
apps/worker     Bun worker: Discord bot, reminders, calendar/background jobs, health server
packages/core   Shared configuration, health, database schema, migrations, and domain operations
scripts         Repository tooling such as the staged-secret scan
```

The worker has no separate build step: Bun runs its TypeScript directly, and
`typecheck` covers it.

## Notes

- `next.config.ts` loads the root `.env` into the dashboard.
- The `typescript` dependency is pinned to 6.x because typescript-eslint does not
  support TypeScript 7 yet. Revisit when it does.
- Next.js generates `apps/web/AGENTS.md` during `next dev` when it detects an AI coding
  agent. It is a framework-managed block; keep it rather than removing it.
