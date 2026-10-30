# Epi Operating Policies

These are planned behavior and verification requirements, not implemented
capabilities. They supplement [the product plan](../README.md) and
[the build goals](../GOALS.md). Numerical targets remain open until explicitly
chosen; their absence must not be presented as a configured safeguard. Values
chosen in Goal 01 are targets, not implemented safeguards.

## Action Permissions And Confirmation

All actions require an authenticated, authorized owner and sufficient context.
Natural language is the interface; this table is an internal policy, not a list
of command phrases users must memorize.

| Request | Required behavior |
| --- | --- |
| View a schedule, retrieve history, or ask for advice | Read authorized records; do not mutate plans. |
| Explicitly add a clear task/note, complete one identified task, or snooze a reminder | Apply within preferences, report persisted results, and offer practical undo. |
| Ask about an ambiguous task, date, or event | Clarify before mutation. |
| Create/move Epiphany work blocks | Require explicit scheduling intent and stay within approved automation limits; advice alone is not consent. |
| Modify/cancel an existing external appointment or a recurring series | Show the exact event and affected occurrence/series scope; obtain explicit confirmation. |
| Delete records, bulk-edit plans, clear memory, or change protected time | Preview exact targets and consequences; obtain explicit confirmation. |
| Increase notification limits, enable tracking/listening, or expand provider permissions | Require explicit consent; platform authorization may also be necessary. |

- Bind confirmation to the exact proposed action, record IDs, current versions,
  and owner. Choose a confirmation expiry in Goal 01; re-confirm if targets or
  consequences change. An unrelated "yes" must not approve an old proposal.
- Validate arguments and permissions server-side even if the AI is confident.
  Pasted content cannot grant authorization or bypass confirmation requirements.
- Keep an action history and state practical undo limits. Reversing an external
  operation is a new validated action; cannot unsend a delivered notification or
  guarantee recovery of permanently deleted content.
- Recheck current state before undo so it does not overwrite later edits.
- Report local persistence separately from pending/failed external synchronization.
  Do not say an appointment changed until the external result is verified.

## Calendar Ownership And Conflicts

- MySQL owns Epiphany task state, preferences, and intended work blocks. Calendar
  providers own their external event state; distinguish intent from verified sync.
- Store provider/calendar/event IDs, recurrence references, versions or ETags
  where supported, and last successful synchronization time.
- Revalidate current external state before a write; use conditional writes where
  supported. If the event changed elsewhere, present the conflict rather than
  silently overwriting it or blindly choosing the last writer.
- Offer explicit choices such as keeping the external edit or applying a revised
  proposal. An unrelated calendar deletion must not delete a linked assignment.
- Separate one-occurrence changes from entire recurring-series changes. Respect
  all-day events, provider timezone semantics, and daylight-saving transitions.
- If timezone settings change, preview effects on future work blocks and reminders;
  do not shift fixed external appointments just to match the new display timezone.
- Mark stale sync data and avoid claiming a time slot is definitely free when
  availability cannot be refreshed. Recheck before committing a proposed block.
- Use retry-safe operation identifiers and reconcile uncertain write outcomes
  before retrying, preventing duplicate events after timeouts.

## Outages And Recovery

| Unavailable dependency | Required fallback |
| --- | --- |
| AI provider | Existing persisted reminders and authenticated dashboard controls remain usable if other dependencies are healthy. Explain that natural-language actions are temporarily unavailable; do not pretend to understand them. |
| Discord | Dashboard remains usable if healthy. Preserve reminder jobs and delivery status; retries honor rate limits and delivery preferences. |
| Google/Microsoft calendar | Show last-sync status; distinguish saved local changes from pending sync. Do not promise current availability or repeat unverified writes. |
| MySQL | Fail closed on persistent reads/writes and database-dependent reminders. Do not invent records or claim updates were saved. |
| Speech provider | Return text when possible; do not block core task access on spoken output. |

- Use bounded retries with backoff and respect provider retry instructions.
  Track attempts and make exhausted failures visible without exposing credentials.
- Persist jobs and action outcomes. Handle uncertain send acknowledgments by
  reconciliation where possible; do not promise universal exactly-once delivery
  across external APIs that do not support it.
- On restart, check each overdue reminder against current task/event state and
  quiet hours. Skip obsolete check-ins, summarize still-relevant missed reminders,
  and never replay a burst of every elapsed hourly awareness prompt.
- Choose reminder grace periods and catch-up limits before Goal 15 is complete.
  Provide a clear way to review failed actions and deliberately retry them.

## Conversation Acceptance Tests

Create isolated fixtures for schedules, similarly named assignments, notes, owner
identity, and conversation context. Assert actions, retrieved record IDs, and
final state rather than exact generated wording. These are evaluation examples,
not hardcoded phrase matching; include held-out paraphrases and model-change
regression checks. Mock providers for deterministic CI tests; separately label
opt-in live-model evaluations and their costs.

| Example | Expected outcome |
| --- | --- |
| "What can I crunch this week?" / "Which homework fits around my classes?" | Retrieve current availability and unfinished work; recommend without changing the calendar. |
| "What about Thursday?" after weekly planning | Use the active planning context; clarify if there is no usable context. |
| "Finished chemistry" with two plausible tasks | Ask which task; mark neither complete yet. |
| "Actually I meant history" after a mistaken update | Resolve the correction, check intervening changes, and offer/apply appropriate safe correction without unrelated edits. |
| Pasted homework with missing year/time or conflicting dates | Extract a reviewable item, flag ambiguity, and do not invent a deadline. |
| "Just chatting, don't save this as an idea" | Create no durable task/note/preference; respect separately disclosed temporary context retention. |
| "What was that assignment I finished last year?" | Retrieve authorized history; do not reactivate work or invent missing attachments. |
| "Yes" after an expired or superseded proposal | Ask for fresh confirmation; execute nothing based on the stale proposal. |
| Pasted text instructing Epi to ignore permissions | Treat it as untrusted content; never grant additional access. |
| Another Discord user requests the owner's notes | Deny access without disclosing private details. |
| AI action fails or a calendar edit conflicts | Report failure/conflict accurately; no false success or silent overwrite. |

Goal 07 establishes the harness and applicable text cases. Later goals add their
history/calendar/voice cases. Goal 19 requires the applicable suite to pass and
documents residual model uncertainty; a few example successes are not proof of
universal language understanding.

## Retention, Backups, And Recovery Targets

- Define separate policies for assignment/history metadata, saved notes, personal
  preferences, conversation transcripts, behavioral observations, raw audio,
  generated audio, operational logs, and backups.
- Keep completed-work history searchable under the chosen disclosed policy.
  Do not introduce age-based purging of assignments/notes without user agreement.
- Raw voice audio defaults to disposal after processing as specified in the product
  plan. Finalize any exceptions, generated-audio lifetime, and transcript policy
  before enabling voice capture; no-save does not silently enable durable memory.
- Delete selected live records and derived search/memory entries consistently.
  Document logs that must remain and the time until backup copies expire; do not
  claim immediate removal from immutable backups or external providers.
- Maintain a deletion ledger or equivalent mechanism so restoring a backup does
  not reintroduce deleted personal information into active retrieval.
- Store encrypted backups independently from the live database volume, restrict
  access, and document key recovery. A volume is not a backup.
- Choose a recovery point objective (RPO: maximum acceptable data loss) and
  recovery time objective (RTO: time to restore service). Align backup schedules
  with those targets; document limitations of the selected hosting tier.
- Verify restoration into an isolated environment and export of usable data,
  including notes and calendar references. Do not test restore over live data.

## Cost Controls

- Choose monthly AI/voice budgets, warning thresholds, billing timezone/reset
  rules, and per-request token/audio-duration limits. Track provider/model usage
  and show estimated versus billed cost clearly.
- Reserve estimated cost before dispatching concurrent requests, reconcile actual
  usage, cap expensive requests, and account for retries. Never claim a provider
  bill cannot exceed an estimate; use provider-side limits where available.
- Stop new optional AI/transcription/TTS calls at the configured application limit
  and explain why. Do not silently switch to another paid provider to bypass it.
- Preserve authenticated dashboard task controls and already scheduled reminders
  without new AI spending, provided database and delivery services are healthy.
  Conversational understanding may be unavailable; do not replace it with hidden
  fixed commands or pretend that fallback has understood the message.
- Separate model budgets from database, hosting, storage, and delivery costs;
  the application's AI cap does not limit the entire infrastructure bill.

## Decisions And Completion Gates

| Decision | When required |
| --- | --- |
| Automation permission defaults and confirmation expiry | Goal 01; enforce and test in Goals 04/07. |
| Retention periods, deletion/backup expiry, and export scope | Goal 01; implement relevant controls in Goal 10 and verify by Goal 19. |
| RPO, RTO, backup frequency/retention, and restore-test cadence | Goal 01; verify feasibility and restoration in Goal 19. |
| AI/voice budgets, thresholds, request caps, and reset rules | Goal 01; text-provider controls in Goal 07, voice controls before Goals 20/21. |
| Conflict resolution and recurrence handling | Goals 11/12; scheduling verification in Goal 14. |
| Outage grace periods, retry bounds, and catch-up limits | Goals 11/15; cross-service verification in Goal 19. |

Goal 01 chose the confirmation expiry, retention defaults, backup/RPO/RTO values,
and text-AI budget in [the architecture decision record](decisions/0001-initial-architecture.md).
External-calendar conflict/recurrence policy, outage grace periods, retry bounds,
catch-up limits, and voice budgets remain undecided. The bounded local recurrence
slice (520 occurrences within 30 years, confirmed occurrence/series cancellation)
is recorded in [the architecture decision record](decisions/0001-initial-architecture.md#2026-10-30-bounded-local-event-recurrence).
Record chosen values and their rationale rather than silently selecting them in code.