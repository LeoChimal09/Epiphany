# Discord

Epi's Discord side runs in the `worker` service (`apps/worker/src/discord/`). It starts only when
`DISCORD_BOT_TOKEN` is set; without it the worker is health-only. Messages go through the same
assistant and services as the dashboard.

## Setting up the application

1. In the Discord Developer Portal create an application and a bot, and copy the bot token into
   `DISCORD_BOT_TOKEN` (Railway runtime secret for `worker`; never a committed file).
2. Under Bot > Privileged Gateway Intents, enable **Message Content Intent**. Without it Epi cannot
   read `#assistant` or DMs.
3. Invite the bot with the `bot` scope and these permissions only: View Channels, Send Messages,
   Read Message History, **Manage Channels**. The permissions integer is `68624` (add Connect and Speak for live voice: `3214352`, see voice.md). Do not grant
   Administrator.
4. Set `OWNER_DISCORD_USER_ID` to your Discord user ID (the same value the dashboard uses).
5. Sign in to the dashboard once with Discord so your owner record exists; Epi links Discord messages
   to it by that ID.

## What Epi does on its own

- **A server you own:** adding Epi is taken as your approval. When Epi starts, or is added, it creates
  the private `epiphany` workspace there (once; later starts change nothing unless a channel is
  missing) and DMs you what it made. If it cannot, for example because a permission is missing, it DMs
  you what it needs, once.
- **A server you are only a member of:** Epi creates nothing and sends you one DM offering to set it up
  when you ask.
- **A server you are not in:** nothing happens.

Epi never posts into other channels by itself.

## Routine Replies And Pasted Lists

Standalone greetings, thanks, and simple yes/no approvals use fixed code rather than a
model call. Channel creation, overview updates, and reminder delivery are also model-free.
Free-form interpretation still uses the configured provider; there is no required command
syntax. The worker's existing AI configuration requirement for private chat still applies,
but these routine paths do not spend tokens and remain usable after the AI budget runs out.

When a message is interpreted as several items to capture, Epi sends a numbered preview
and saves nothing until you approve. Long previews arrive as multiple messages so no item
or approval instruction is cut off. Check dates and categories, then reply yes to save or
no to discard. For corrections, send the corrected list instead. Approval is model-free,
rechecks current records for duplicates, and preserves the original task source message.
An unrelated message discards the preview; it also expires after ten minutes and is lost
when the worker restarts. Single-item requests retain immediate-save behavior.

Complete pasted course cards can be interpreted in code without AI tokens; ambiguous
or incomplete layouts still use language understanding. The numbered preview is always
required for these multi-item imports, including after the monthly model budget is used.
Idea follow-ups append bullets to the active saved idea and can include model feedback
in the same call; long idea replies are also delivered in full across messages.

## Overview channels

Once the workspace exists, Epi keeps one message in each of `today`, `schedule`, `priorities`,
`notes-and-ideas`, and `activity-log` up to date. (`check-ins` waits for reminders, Goal 15.)

- The message is **edited in place**, never reposted. It is rebuilt from the database, so a change
  made in Discord or in the dashboard shows up: right away for changes made in Discord, and within
  about 30 seconds for dashboard changes (the worker compares the records with what it last posted).
  Nothing is sent when nothing changed.
- If someone **deletes an overview message**, Epi posts it again. Only the message is gone; no task,
  note, or event is touched.
- A lost record of which message belongs to a view does not cause a duplicate: Epi finds its earlier
  message by a small marker line and reuses it. Retries are safe.
- Epi writes only into those channels, only while `@everyone` cannot see them, and with mentions
  switched off. Titles are escaped so a task called `@everyone` cannot ping anyone.
- Each message stays under Discord's 2000-character limit and says how much it left out.
- The dashboard refreshes itself every 30 seconds while it is open and visible, so a completion made
  in Discord appears there without pressing Refresh.
- Saying "undo" (any wording) reverses the last completion or category move from the same
  conversation. Older changes are undone from the dashboard (Reopen, Edit).

## If the bot is silent

The worker's logs say what is happening (Railway > `worker` > Deploy Logs):

- No `discord_ready` line: the bot never connected. The `worker` service needs `DISCORD_BOT_TOKEN`,
  `OWNER_DISCORD_USER_ID`, `DATABASE_URL`, and `OPENAI_API_KEY` (the dashboard's variables do not carry
  over to a separate service). A login failure about "disallowed intents" means Message Content Intent
  is off in the Developer Portal.
- `discord_ready` with `guilds: 0`: the bot is not in any server; reinvite it.
- `workspace_auto_setup` with `problem_reported`: setup failed and you were DMed why (usually a missing
  permission on Epi's role). `not_member`: Epi cannot see you in that server. `dm_failed`: your DMs
  from server members are off, so allow them. `not_owner` is followed by a `workspace_offer` line.
- Replies like "its OpenAI key is not configured yet" mean the `worker` has no `OPENAI_API_KEY`.
- In a server channel Epi only answers a mention, and then only to point you to a DM. Setup is asked
  for in a DM.

## Who Epi answers

- Only the owner. Other users and bots are ignored everywhere and receive nothing.
- **DMs** and the **`#assistant` channel in the private `epiphany` category** are private: every owner
  message is for Epi, no prefix or mention needed.
- A channel counts as private only when Discord reports that `@everyone` cannot see it. A look-alike
  `#assistant` that everyone can see is treated as shared.
- In any other channel Epi stays quiet unless mentioned, and then answers as a **shared** audience:
  it makes no model call and shows no personal data, only a note that it works in private
  conversations.
- Server admins can always see every channel; keep Epi's category in a server you trust.

## Setting up the workspace

Setup is conversational: tell Epi, in a DM or `#assistant`, to set up your workspace (any wording; there
is no command). Epi then:

- looks only at servers it shares with you, so a stranger adding Epi to their server gets nothing;
- asks which server if there is more than one, and tells you to invite it if there are none;
- creates a private `epiphany` category with `assistant`, `today`, `schedule`, `priorities`,
  `notes-and-ideas`, `check-ins` and `activity-log`, each hidden from `@everyone` and open only to you
  and Epi;
- reuses what exists. Asking again creates nothing, and a deleted channel is recreated without touching
  the others. It never renames, moves, or deletes anything;
- when asked from a server channel, also sends you a DM to prove it can reach you, and says so if your
  DMs are blocked.

If Discord refuses (usually a missing permission) Epi stops, says what it had already created, and a
later request continues from there.

## Known limits

- The gateway, channel creation, and DM check have unit tests with fake Discord objects but have not
  been run against a live server.
- The overview and sync code is tested against fake Discord objects and a real database, not a live
  server. Threads for detailed items, buttons, and `check-ins` are not built.
- Conversation context is kept in memory per channel and resets when the worker restarts.
