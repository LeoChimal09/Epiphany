# Access And Security Model

How Epiphany decides who may read or change personal records (Goal 04). The code lives in
`packages/core/src/services/` (permissions, principals, confirmations, validated services) and
`packages/core/src/auth/` (sessions, owner identity); the dashboard's sign-in and API are in
`apps/web/lib/`. Discord and voice features will call the same services.

## One path to the data

Every read or write of personal records goes through `createServices(db)`. Each method:

1. Requires a **principal** (an authenticated owner). Principals are issued only after the caller's
   identity was verified, and only by `issueOwnerPrincipal`, which checks the owner exists. A plain
   object shaped like a principal (for example from model output or pasted content) is rejected at
   runtime, so it cannot be forged.
2. Checks the **permission matrix** for the action.
3. **Validates** the input (strict schemas: unknown fields, bad dates, oversized text are refused
   before the database is touched).
4. Runs the domain operation, scoped to the owner, and writes **action history** in the same
   transaction.
5. Returns the row **re-read from MySQL**, never an optimistic copy.

Another owner's record is reported as "not found", never "forbidden", so nothing about it leaks.

## Permission matrix

From [the operating policies](operating-policies.md); enforced by `decide`/`authorize`.

| Class                          | Examples                                                    | Outcome                                                                  |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| read                           | view tasks, events, history                                 | Allowed; never changes anything.                                         |
| apply                          | create/complete a task, add a note, cancel a local event    | Allowed and undoable.                                                    |
| schedule                       | create/remove Epiphany work blocks                          | Owner controls: allowed. Assistant: only with explicit scheduling intent. |
| external                       | change an external appointment or recurring series         | Needs confirmation.                                                      |
| destructive                    | delete records, bulk edit, clear memory, change protected time | Needs confirmation.                                                   |
| escalate                       | raise notification limits, enable tracking/listening        | Needs explicit consent.                                                  |
| unknown action                 |                                                             | Denied.                                                                  |

Advice is not consent: an assistant asking "should I schedule this?" cannot create a work block.

## Confirmations

A consequential action is first **proposed**: the service reads the current targets and their
versions, stores a preview, and returns a confirmation ID and hash. Nothing changes yet. It runs
only when **confirmed** with that ID and hash, and only if all of these hold:

- The confirmation is still pending (single-use) and has not expired (**10 minutes**).
- The hash matches the proposal (same action, payload, targets, owner).
- The targets still have the **same versions**. If anything changed, the confirmation is void
  (`stale`) and a fresh one is needed.
- Confirming and executing happen in one transaction.

A newer proposal for the same payload supersedes the older one, so a stale "yes" cannot approve
it. Confirmable handlers include `note.delete`, `preference.delete`, `memory.clear`,
and `event.cancel_series` (one local occurrence or all scheduled occurrences).
Recurring cancellation binds every affected event's ID/version and owner, retains
history, and cancels its scheduled reminders atomically. Direct `events.cancel`
cannot bypass confirmation for an occurrence with a local series ID. Imported
external events remain read-only through this flow. Other unimplemented handlers
are refused with a clear message.

## Shared channels

A principal has an **audience**: `private` (dashboard, DM) or `shared` (any other channel). A shared
audience is denied for **every** action, including confirming or canceling, with a generic message
that contains no record details. Widening this requires adding an action to an explicit
allow-list in `permissions.ts` and a test.

## Dashboard sign-in

- Discord OAuth (`identify` scope only), authorization-code flow with `state` and PKCE.
- Only the Discord account in `OWNER_DISCORD_USER_ID` can sign in. The first successful sign-in
  creates the owner record for it; every other account is refused and creates nothing.
- Sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-` and
  `Secure` on HTTPS). Only a SHA-256 hash is stored, so a copy of the database cannot be replayed.
  They last 7 days and end immediately on sign-out.
- Mutating requests must come from the dashboard's own origin; cross-site requests get 403.
- Discord's access token is used once to read the user ID, display name, and avatar hash, then
  revoked and discarded. The name and avatar hash are validated and stored on the owner record so
  the dashboard can show them; the avatar URL is built from the hash, never stored from Discord.
- If sign-in is not configured, the dashboard fails closed: APIs answer 503, the login page says
  it is not set up, and details go to the server log only.

## Development bypass (`ENV_BYPASS=dev`)

For local development when Discord sign-in is impractical (for example behind a company proxy that
inspects HTTPS), setting `ENV_BYPASS=dev` adds a "Continue as dev owner" button that creates a real
session for the owner without Discord. Unset or empty means normal Discord sign-in.

It is a deliberate hole in the front door, so it is tightly limited:

- **Development only.** The configuration loader refuses it (it does not silently ignore it) unless
  `NODE_ENV` is `development` or `test`. A production build with `ENV_BYPASS=dev` set disables
  sign-in entirely (APIs answer 503, no button) and logs what to unset.
- **Localhost only.** `APP_URL` must be `localhost`, `127.0.0.1`, or `[::1]`, and each request must be
  addressed to one of those by both URL and `Host` header.
- **Exactly `dev`.** Any other value (`DEV`, `true`, `prod`) is a configuration error.
- **POST and same-origin only.** A link or image tag cannot sign anyone in; cross-site requests get 403.
- **Loopback bind.** `bun run dev` binds to `localhost` only, so other machines on the network cannot
  reach the dev server at all. This matters because a `Host` header can be forged by someone who can
  reach the port. Do not run the dev server bound to a network address with the bypass on.
- **Real sessions, audited.** The session is the same kind as a Discord one (hashed token, 7 days). Each
  bypass sign-in writes an `auth.dev_bypass_sign_in` history entry and a log line, and the dashboard
  shows a "Development bypass is on" notice.
- **Which owner.** If `OWNER_DISCORD_USER_ID` is set, the bypass signs in as that same owner (same
  data as a real sign-in). If not, it uses a separate local "Dev Owner" with no Discord ID.

Keep `ENV_BYPASS` out of any deployed environment. Treat data in a bypass-enabled database as
disposable.

## Set up sign-in

1. Create an application at <https://discord.com/developers/applications>.
2. OAuth2 > Redirects: add `<APP_URL>/api/auth/discord/callback`
   (`http://localhost:3000/api/auth/discord/callback` locally).
3. Put the client ID and secret in `.env` as `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`, and your
   own user ID as `OWNER_DISCORD_USER_ID` (Discord > Settings > Advanced > Developer Mode, then
   right-click your name > Copy User ID).
4. `bun run dev`, open the dashboard, and choose "Sign in with Discord".

## HTTP API (so far)

| Method and path                  | Purpose                                         |
| -------------------------------- | ----------------------------------------------- |
| `GET /api/tasks`                 | List tasks (`status`, `limit`, `offset`).        |
| `POST /api/tasks`                | Create a task.                                  |
| `POST /api/tasks/{id}/complete`  | Complete a task.                                |
| `GET /api/auth/discord`          | Start sign-in.                                  |
| `GET /api/auth/discord/callback` | Finish sign-in (Discord redirects here).         |
| `POST /api/auth/logout`          | End the session.                                |

Responses: 401 not signed in, 403 forbidden or cross-site, 404 not found, 409 confirmation
needed, 422 invalid input (with the reasons), 503 sign-in not configured.

## Google Calendar tokens (Goal 11)

Setup and behavior: [calendar](calendar.md). The security rules:

- **Encrypted at rest.** Access and refresh tokens are stored only as AES-256-GCM ciphertext
  (`v1.<iv>.<tag>.<data>`) using `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64). The account ID and
  token kind are bound in as authenticated data, so a ciphertext copied to another row or swapped
  between tokens fails to decrypt. A copy of the database alone is not enough to use the tokens.
- **Never exposed.** Service views list columns explicitly and contain no token fields; routes never
  query tables. Tokens, codes, and request/response bodies are never logged; errors carry only
  status codes and Google's short reason.
- **Least scope.** Epiphany asks for `calendar.readonly` (read the calendars you pick) and
  `calendar.app.created` (write only calendars Epiphany created itself), plus `openid email` to
  identify the account. It cannot edit your own calendars even with a bug. "Read-only" skips the write scope.
- **Owner-only, with consent.** Only the signed-in owner can start a connection (`state` + PKCE, a
  10-minute HttpOnly cookie). The `calendar.connect` action is an *escalate* action: it needs
  consent, and only the owner finishing Google's consent screen counts (not the assistant, not a
  shared channel). Disconnect is a same-origin POST from the signed-in owner.
- **Disconnect ends access first.** Tokens are deleted and the account marked `revoked` in one
  transaction (the database refuses a revoked account that holds tokens), then the token is revoked at
  Google (best effort). Every Google call re-reads the account, so a sync running during a
  disconnect stops at its next request.
- **Revoked or expired access is visible.** `invalid_grant` (or a token Google still refuses after
  a refresh) wipes the tokens, marks the account `needs_reauth`, and shows the reason on the Calendars page.
- **Never silent writes.** The only write path is gated by `assertOwnWrite`: the target must be the
  dedicated Epiphany calendar and write access must have been granted. Events from other calendars
  are read-only.
- **If `TOKEN_ENCRYPTION_KEY` is lost or rotated**, saved tokens cannot be decrypted; sync fails
  with an error and the owner reconnects. There is no automatic key rotation yet.

## Known limits

- The live Discord token exchange has not completed from the development machine, because the
  company network's HTTPS inspection blocks it (see local development). The consent screen and
  redirect work; the exchange is tested against a stubbed Discord, and the bypass covers day-to-day
  development.
- No rate limiting on sign-in or the API yet.
- Sessions do not slide: they end 7 days after sign-in.
- Only the task API exists over HTTP; notes, events, and work blocks are service-level for now.
