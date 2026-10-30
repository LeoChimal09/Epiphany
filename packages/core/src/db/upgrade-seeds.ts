// Representative rows valid at the schema AFTER the named migration was applied. The upgrade
// test installs that schema, inserts these rows, applies every later migration, and checks the
// rows survived. Adding a migration requires adding a seed here for the migration before it
// (the one that was the latest until now) so the real upgrade path stays tested.
const EARLIER_SEED_0000: string[] = [
  "INSERT INTO owners (id, display_name, discord_user_id) VALUES ('owner-1', 'Seed Owner', '100000000000000001')",
  "INSERT INTO categories (id, owner_id, name, system_key) VALUES ('cat-inbox', 'owner-1', 'Inbox', 'inbox'), ('cat-school', 'owner-1', 'School', NULL)",
  "INSERT INTO tasks (id, owner_id, category_id, title, due_at, status, completed_at) VALUES ('task-open', 'owner-1', 'cat-school', 'Open essay', '2026-10-16 04:59:59.123', 'open', NULL), ('task-done', 'owner-1', 'cat-inbox', 'Done worksheet', NULL, 'completed', '2026-10-01 12:00:00.000')",
  "INSERT INTO events (id, owner_id, title, starts_at, ends_at, timezone, status, canceled_at) VALUES ('event-1', 'owner-1', 'Lab', '2026-10-14 20:00:00.000', '2026-10-14 21:30:00.000', 'America/Chicago', 'canceled', '2026-10-13 12:00:00.000')",
  "INSERT INTO work_blocks (id, owner_id, task_id, starts_at, ends_at, status, removed_at, removed_reason) VALUES ('block-1', 'owner-1', 'task-open', '2026-10-15 15:00:00.000', '2026-10-15 16:00:00.000', 'removed', '2026-10-13 12:00:00.000', 'manual')",
  "INSERT INTO notes (id, owner_id, category_id, kind, title, body) VALUES ('note-1', 'owner-1', 'cat-inbox', 'idea', 'App idea', 'A note that must survive')",
  "INSERT INTO preferences (id, owner_id, pref_key, value, status) VALUES ('pref-1', 'owner-1', 'work.window', JSON_OBJECT('start', '15:00'), 'confirmed')",
  "INSERT INTO action_history (id, owner_id, source, action, entity_type, entity_id) VALUES ('hist-1', 'owner-1', 'dashboard', 'task.create', 'task', 'task-open')",
];

const SEED_0008_GOOGLE_CALENDAR: string[] = [
  ...EARLIER_SEED_0000,
  "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
  "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('b', 64), 'owner-1', '2026-12-01 00:00:00.000')",
  "INSERT INTO ai_usage (owner_id, period, cost_micros, calls) VALUES ('owner-1', '2026-10', 1234567, 3)",
  "UPDATE owners SET avatar_hash = REPEAT('c', 32) WHERE id = 'owner-1'",
  "UPDATE tasks SET review_note = 'no due date given' WHERE id = 'task-open'",
  "INSERT INTO discord_overviews (owner_id, guild_id, view_key, channel_id, message_id, content_hash) VALUES ('owner-1', '300000000000000001', 'today', '400000000000000001', '500000000000000001', REPEAT('d', 64))",
  "INSERT INTO reminders (id, owner_id, kind, subject_type, subject_id, dedupe_key, message, due_at) VALUES ('reminder-1', 'owner-1', 'task_deadline', 'task', 'task-open', 'task_deadline:task-open:1', 'Open essay is due soon', '2026-10-15 22:00:00.000')",
];

const SEED_0009_VOICE_USAGE_OBSERVATIONS: string[] = [
  ...SEED_0008_GOOGLE_CALENDAR,
  "INSERT INTO observations (id, owner_id, kind, subject_key, value) VALUES ('observation-1', 'owner-1', 'duration', 'school:essay', 45)",
  "INSERT INTO provider_usage (owner_id, provider, period, cost_micros, calls) VALUES ('owner-1', 'elevenlabs', '2026-10', 123456, 2)",
];

export const UPGRADE_SEEDS: Record<string, string[]> = {
  "0013_backfill_task_types": [
    ...SEED_0009_VOICE_USAGE_OBSERVATIONS,
    "UPDATE tasks SET task_type = 'todo', priority = 'minor' WHERE id = 'task-done'",
    "UPDATE tasks SET task_type = 'task', priority = 'major', split_reminder_count = 2 WHERE id = 'task-open'",
    "UPDATE events SET split_reminder_count = 3 WHERE id = 'event-1'",
  ],
  "0012_simple_patriot": [
    ...SEED_0009_VOICE_USAGE_OBSERVATIONS,
    "UPDATE tasks SET task_type = 'todo', priority = 'minor' WHERE id = 'task-done'",
    "UPDATE tasks SET task_type = 'task', priority = 'major' WHERE id = 'task-open'",
  ],
  "0011_nebulous_outlaw_kid": [
    ...SEED_0009_VOICE_USAGE_OBSERVATIONS,
    "UPDATE tasks SET task_type = 'todo', priority = 'minor' WHERE id = 'task-done'",
    "UPDATE tasks SET task_type = 'task', priority = 'major' WHERE id = 'task-open'",
  ],
  "0000_initial_schema": EARLIER_SEED_0000,
  // Schema after 0001 adds confirmations; it carries the earlier rows plus a confirmation.
  "0001_confirmations": [
    ...EARLIER_SEED_0000,
    "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
  ],
  "0002_sessions": [
    ...EARLIER_SEED_0000,
    "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
    "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('b', 64), 'owner-1', '2026-12-01 00:00:00.000')",
  ],
  // Schema after 0003 adds ai_usage; it carries the earlier rows plus a month of recorded spend.
  "0003_ai_usage": [
    ...EARLIER_SEED_0000,
    "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
    "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('b', 64), 'owner-1', '2026-12-01 00:00:00.000')",
    "INSERT INTO ai_usage (owner_id, period, cost_micros, calls) VALUES ('owner-1', '2026-10', 1234567, 3)",
  ],
  // Schema after 0004 adds owners.avatar_hash; the owner row now carries one.
  "0004_owner_avatar": [
    ...EARLIER_SEED_0000,
    "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
    "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('b', 64), 'owner-1', '2026-12-01 00:00:00.000')",
    "INSERT INTO ai_usage (owner_id, period, cost_micros, calls) VALUES ('owner-1', '2026-10', 1234567, 3)",
    "UPDATE owners SET avatar_hash = REPEAT('c', 32) WHERE id = 'owner-1'",
  ],
  // Schema after 0005 adds tasks.review_note; one task now carries a review flag.
  "0005_task_review_note": [
    ...EARLIER_SEED_0000,
    "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
    "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('b', 64), 'owner-1', '2026-12-01 00:00:00.000')",
    "INSERT INTO ai_usage (owner_id, period, cost_micros, calls) VALUES ('owner-1', '2026-10', 1234567, 3)",
    "UPDATE owners SET avatar_hash = REPEAT('c', 32) WHERE id = 'owner-1'",
    "UPDATE tasks SET review_note = 'no due date given' WHERE id = 'task-open'",
  ],
  // Schema after 0006 adds discord_overviews; one overview message is bound.
  "0006_discord_overviews": [
    ...EARLIER_SEED_0000,
    "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
    "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('b', 64), 'owner-1', '2026-12-01 00:00:00.000')",
    "INSERT INTO ai_usage (owner_id, period, cost_micros, calls) VALUES ('owner-1', '2026-10', 1234567, 3)",
    "UPDATE owners SET avatar_hash = REPEAT('c', 32) WHERE id = 'owner-1'",
    "UPDATE tasks SET review_note = 'no due date given' WHERE id = 'task-open'",
    "INSERT INTO discord_overviews (owner_id, guild_id, view_key, channel_id, message_id, content_hash) VALUES ('owner-1', '300000000000000001', 'today', '400000000000000001', '500000000000000001', REPEAT('d', 64))",
  ],
  // Schema after 0007 adds reminders; one scheduled reminder for the open task.
  "0007_reminders": [
    ...EARLIER_SEED_0000,
    "INSERT INTO confirmations (id, owner_id, action, status, targets, payload, payload_hash, preview, source, expires_at) VALUES ('confirm-1', 'owner-1', 'note.delete', 'pending', JSON_ARRAY(JSON_OBJECT('entityType', 'note', 'entityId', 'note-1', 'version', 1)), JSON_OBJECT('noteId', 'note-1'), REPEAT('a', 64), JSON_OBJECT('summary', 'Delete the idea'), 'dashboard', '2026-10-13 15:10:00.000')",
    "INSERT INTO sessions (id, owner_id, expires_at) VALUES (REPEAT('b', 64), 'owner-1', '2026-12-01 00:00:00.000')",
    "INSERT INTO ai_usage (owner_id, period, cost_micros, calls) VALUES ('owner-1', '2026-10', 1234567, 3)",
    "UPDATE owners SET avatar_hash = REPEAT('c', 32) WHERE id = 'owner-1'",
    "UPDATE tasks SET review_note = 'no due date given' WHERE id = 'task-open'",
    "INSERT INTO discord_overviews (owner_id, guild_id, view_key, channel_id, message_id, content_hash) VALUES ('owner-1', '300000000000000001', 'today', '400000000000000001', '500000000000000001', REPEAT('d', 64))",
    "INSERT INTO reminders (id, owner_id, kind, subject_type, subject_id, dedupe_key, message, due_at) VALUES ('reminder-1', 'owner-1', 'task_deadline', 'task', 'task-open', 'task_deadline:task-open:1', 'Open essay is due soon', '2026-10-15 22:00:00.000')",
  ],
  "0008_google_calendar": SEED_0008_GOOGLE_CALENDAR,
  "0009_voice_usage_observations": SEED_0009_VOICE_USAGE_OBSERVATIONS,
  "0010_task_priority": [
    ...SEED_0009_VOICE_USAGE_OBSERVATIONS,
    "UPDATE tasks SET priority = 'major' WHERE id = 'task-open'",
  ],
};
