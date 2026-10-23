# Local Development

Commands here exist as of Goal 03. The dashboard and worker run and the database schema and
migrations exist ([database](database.md)); no planning, Discord, or AI features are
implemented yet, and no service is deployed.

## Requirements

- Bun 1.3.14 (pinned in `.bun-version` and `package.json`) and Node 24 or newer
  (`.node-version`). Next.js and ESLint run on Node; the worker runs on Bun.
- Docker, only for the local MySQL container.

## Setup

```sh
bun install
cp .env.example .env
```

`.env` is ignored by git and shared by the dashboard, worker, and Docker Compose. It is laid
out like the other projects' examples: banner-style sections, inline hints, and every variable
listed with a blank value. Sections marked "not read yet" are for later goals and do nothing
today. The example's local defaults (database, user, and password `epiphany`, MySQL on port
3319, worker health on 3001) match `docker-compose.yml`, so it works as copied. That password is
for the local container only, which listens on 127.0.0.1; use a strong generated one
(`openssl rand -hex 16`, in both `DATABASE_URL` and `MYSQL_PASSWORD`) anywhere else. `DATABASE_URL`
is required. A missing or invalid value stops each service at startup with a message naming
the variable (values are never printed).

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
| `bun run build` / `bun run start` | Production build and server for the dashboard.                   |
| `bun run db:up` / `db:down`       | Start or stop the local MySQL 8.4 container on 127.0.0.1:3319.   |
| `bun run db:migrate` / `db:status` | Apply or inspect migrations; see [database](database.md).        |

Health responses report configuration only; database connectivity is still reported as
`not_checked` (the services do not use the database yet). Stop the worker with Ctrl+C or
SIGTERM; it closes its health server and exits.

## Checks

| Command                     | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `bun run lint`              | ESLint with no accepted warnings.                                    |
| `bun run format:check`      | Prettier check for code and config (Markdown is not formatted).      |
| `bun run typecheck`         | `tsc --noEmit` for the root projects and the dashboard.              |
| `bun run check`             | Lint, format check, and typecheck.                                   |
| `bun run test:run`          | Vitest once. Database tests need `bun run db:test:up` and `TEST_MYSQL_ADMIN_URL`; otherwise they are skipped. |
| `bun run db:check`          | Fail if schema and migrations disagree.                              |
| `bun run security:staged`   | Scan staged git changes for likely secrets; prints no values.        |
| `bun run precommit:check`   | `check` plus migration drift and the staged-secret scan. It never commits. |

`bun run format` rewrites files with Prettier. No git hooks are installed; run
`precommit:check` yourself when you choose to commit.
Lint and formatting ignore generated Next.js output (`.next`, `.next-*`, and
`build-ci`), including isolated production/release-gate builds. The release gate
uses the same lint script as the precommit checks.
When `TEST_MYSQL_ADMIN_URL` is configured, Vitest runs at most two files in parallel
to avoid overwhelming the shared disposable MySQL server with concurrent migrations.
Unit-only runs keep Vitest's normal worker defaults.

The staged-secret scan recognizes Discord, OpenAI, Google, and Microsoft credential
shapes, private keys, secret-named assignments, MySQL URLs with real passwords, and
staged environment, key, audio, and database files. It is a safety net, not a
guarantee: it cannot find every secret.

## Layout

```text
apps/web        Next.js dashboard and API routes (see apps/web/AGENTS.md)
apps/worker     Bun worker: health server now; Discord bot and reminders later
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
