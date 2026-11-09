import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { getTask, getEvent, newId, NotFoundError, VersionConflictError } from "../db/domain";
import { actionHistory, chatSessions, notes } from "../db/schema";
import { chatDataSchema, chatTopicSchema, type ChatSession } from "../assistant/chat-session";
import { assertPrincipal } from "./principal";
import { authorize } from "./permissions";
import { parseInput, idInput } from "./schemas";

const RETENTION_MS = 90 * 86_400_000;
const TURN_MS = 5 * 60_000;

export function createChatSessions(db: Database, clock: () => Date) {
  function gate(principal: unknown, action: "conversation.read" | "conversation.write") {
    assertPrincipal(principal);
    authorize(principal, action);
    return principal;
  }
  async function get(ownerId: string, id: string) {
    await prune(ownerId);
    const [row] = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.ownerId, ownerId),
          eq(chatSessions.id, id),
          gt(chatSessions.expiresAt, clock()),
        ),
      );
    if (!row) throw new NotFoundError("Conversation");
    return row;
  }
  async function prune(ownerId: string) {
    await db
      .delete(chatSessions)
      .where(and(eq(chatSessions.ownerId, ownerId), lte(chatSessions.expiresAt, clock())));
  }
  function view(row: typeof chatSessions.$inferSelect): ChatSession {
    const data = parseInput(chatDataSchema, row.data);
    const busy = Boolean(row.busyUntil && row.busyUntil > clock());
    if (!busy && (row.turnToken || data.messages.at(-1)?.role === "user")) {
      data.messages = [
        ...data.messages.slice(-99),
        {
          id: (data.messages.at(-1)?.id ?? 0) + 1,
          role: "epi",
          text: "The last request was interrupted. Check the saved record before retrying; it may already have changed.",
          outcome: "uncertain",
        },
      ];
    }
    return { id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString(), data, busy };
  }
  return {
    async list(principal: unknown) {
      const p = gate(principal, "conversation.read");
      await prune(p.ownerId);
      const rows = await db
        .select({
          id: chatSessions.id,
          title: chatSessions.title,
          updatedAt: chatSessions.updatedAt,
        })
        .from(chatSessions)
        .where(and(eq(chatSessions.ownerId, p.ownerId), gt(chatSessions.expiresAt, clock())))
        .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
        .limit(50);
      return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
    },
    async get(principal: unknown, rawId: unknown) {
      const p = gate(principal, "conversation.read");
      return view(await get(p.ownerId, parseInput(idInput, rawId)));
    },
    async create(principal: unknown, rawTopic: unknown = null) {
      const p = gate(principal, "conversation.write");
      let topic =
        rawTopic === null || rawTopic === undefined ? null : parseInput(chatTopicSchema, rawTopic);
      if (topic) {
        authorize(
          p,
          topic.kind === "task" ? "task.read" : topic.kind === "event" ? "event.read" : "note.read",
        );
        if (topic.kind === "note") {
          const [note] = await db
            .select()
            .from(notes)
            .where(
              and(eq(notes.ownerId, p.ownerId), eq(notes.id, topic.id), isNull(notes.archivedAt)),
            );
          if (!note) throw new NotFoundError("Note");
          topic = {
            ...topic,
            label: note.kind,
            title:
              note.title?.trim() ||
              note.body
                .split("\n")
                .find((line) => line.trim())
                ?.slice(0, 80) ||
              "Untitled note",
          };
        } else if (topic.kind === "task") {
          const task = await getTask(db, p.ownerId, topic.id);
          topic = { ...topic, label: task.taskType, title: task.title };
        } else {
          const event = await getEvent(db, p.ownerId, topic.id);
          topic = { ...topic, label: "event", title: event.title };
        }
      }
      const now = clock();
      if (!topic) {
        // Reuse an unused blank conversation instead of piling up "New conversation" entries.
        const [blank] = await db
          .select({ id: chatSessions.id })
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.ownerId, p.ownerId),
              eq(chatSessions.title, "New conversation"),
              isNull(chatSessions.turnToken),
              gt(chatSessions.expiresAt, now),
            ),
          )
          .orderBy(desc(chatSessions.updatedAt))
          .limit(1);
        if (blank) {
          const existing = view(await get(p.ownerId, blank.id));
          if (!existing.data.messages.length && !existing.data.topic) {
            await db
              .update(chatSessions)
              .set({ updatedAt: now })
              .where(and(eq(chatSessions.ownerId, p.ownerId), eq(chatSessions.id, blank.id)));
            return view(await get(p.ownerId, blank.id));
          }
        }
      }
      const id = newId();
      const data = {
        messages: [],
        conversation: {
          turns: [],
          listed: [],
          pending: null,
          focus: topic ? { kind: topic.kind, id: topic.id } : null,
        },
        topic,
      };
      await db.transaction(async (tx) => {
        await tx
          .delete(chatSessions)
          .where(and(eq(chatSessions.ownerId, p.ownerId), lte(chatSessions.expiresAt, now)));
        await tx.insert(chatSessions).values({
          id,
          ownerId: p.ownerId,
          title: topic?.title ?? "New conversation",
          data,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        });
        await tx.insert(actionHistory).values({
          id: newId(),
          ownerId: p.ownerId,
          source: p.source,
          action: "conversation.create",
          entityType: "conversation",
          entityId: id,
          createdAt: now,
        });
      });
      return view(await get(p.ownerId, id));
    },
    async claim(principal: unknown, rawId: unknown, rawMessage: unknown) {
      const p = gate(principal, "conversation.write");
      const id = parseInput(idInput, rawId);
      const message = parseInput(z.string().trim().min(1).max(8000), rawMessage);
      const row = await get(p.ownerId, id);
      const session = view(row);
      if (session.busy) throw new VersionConflictError("Conversation", row.version);
      const token = newId();
      const now = clock();
      session.data.messages = [
        ...session.data.messages.slice(-98),
        {
          id: (session.data.messages.at(-1)?.id ?? 0) + 1,
          role: "user",
          text: message,
        },
      ];
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(chatSessions)
          .set({
            data: session.data,
            turnToken: token,
            busyUntil: new Date(now.getTime() + TURN_MS),
            title:
              session.data.topic?.title ??
              (row.title === "New conversation"
                ? message.replace(/\s+/g, " ").slice(0, 80)
                : row.title),
            updatedAt: now,
            version: row.version + 1,
          })
          .where(
            and(
              eq(chatSessions.id, id),
              eq(chatSessions.ownerId, p.ownerId),
              eq(chatSessions.version, row.version),
              or(isNull(chatSessions.busyUntil), lte(chatSessions.busyUntil, now)),
            ),
          )
          .returning({ id: chatSessions.id });
        if (!updated.length) throw new VersionConflictError("Conversation", row.version);
        await tx.insert(actionHistory).values({
          id: newId(),
          ownerId: p.ownerId,
          source: p.source,
          action: "conversation.turn",
          entityType: "conversation",
          entityId: id,
          createdAt: now,
        });
      });
      return { session: view(await get(p.ownerId, id)), token };
    },
    async finish(principal: unknown, rawId: unknown, rawToken: unknown, rawData: unknown) {
      const p = gate(principal, "conversation.write");
      await prune(p.ownerId);
      const id = parseInput(idInput, rawId);
      const token = parseInput(idInput, rawToken);
      const data = parseInput(chatDataSchema, rawData);
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(chatSessions)
          .set({
            data,
            turnToken: null,
            busyUntil: null,
            updatedAt: clock(),
            version: sql`${chatSessions.version} + 1`,
          })
          .where(
            and(
              eq(chatSessions.ownerId, p.ownerId),
              eq(chatSessions.id, id),
              eq(chatSessions.turnToken, token),
              gt(chatSessions.expiresAt, clock()),
            ),
          )
          .returning({ id: chatSessions.id });
        if (!updated.length) throw new VersionConflictError("Conversation", 0);
        await tx.insert(actionHistory).values({
          id: newId(),
          ownerId: p.ownerId,
          source: p.source,
          action: "conversation.reply",
          entityType: "conversation",
          entityId: id,
          createdAt: clock(),
        });
      });
      return view(await get(p.ownerId, id));
    },
    async remove(principal: unknown, rawId: unknown) {
      const p = gate(principal, "conversation.write");
      const id = parseInput(idInput, rawId);
      const row = await get(p.ownerId, id);
      const now = clock();
      if (row.busyUntil && row.busyUntil > now) {
        throw new VersionConflictError("Conversation", row.version);
      }
      await db.transaction(async (tx) => {
        const deleted = await tx
          .delete(chatSessions)
          .where(
            and(
              eq(chatSessions.ownerId, p.ownerId),
              eq(chatSessions.id, id),
              eq(chatSessions.version, row.version),
              or(isNull(chatSessions.busyUntil), lte(chatSessions.busyUntil, now)),
            ),
          )
          .returning({ id: chatSessions.id });
        if (!deleted.length) throw new VersionConflictError("Conversation", row.version);
        await tx.insert(actionHistory).values({
          id: newId(),
          ownerId: p.ownerId,
          source: p.source,
          action: "conversation.delete",
          entityType: "conversation",
          entityId: id,
          createdAt: now,
        });
      });
    },
  };
}
