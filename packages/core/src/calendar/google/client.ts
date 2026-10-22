import { z } from "zod";
import type { FetchLike } from "./oauth";
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleConflictError,
  GoogleGoneError,
  GoogleNotFoundError,
  GooglePreconditionError,
  GoogleRateLimitError,
  UncertainWriteError,
} from "./errors";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const EPIPHANY_KEY_PROPERTY = "epiphanyKey";

const timeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

export const googleEventSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  etag: z.string().optional(),
  updated: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  start: timeSchema.optional(),
  end: timeSchema.optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: timeSchema.optional(),
  eventType: z.string().optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});
export type GoogleEvent = z.infer<typeof googleEventSchema>;
export type GoogleEventTime = z.infer<typeof timeSchema>;

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  timeZone: string | null;
  accessRole: string | null;
  primary: boolean;
}

export interface GoogleEventBody {
  summary: string;
  description?: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  id?: string;
  extendedProperties?: { private: Record<string, string> };
}

export interface EventPage {
  events: GoogleEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
  skipped: number;
}

export interface GoogleClientOptions {
  // Returns a valid access token. forceRefresh is set after Google answered 401.
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const IDEMPOTENT = new Set(["GET", "DELETE", "HEAD"]);

interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

async function readError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
    };
    const reason = body.error?.errors?.[0]?.reason;
    if (typeof reason === "string") return reason;
    return typeof body.error?.status === "string" ? body.error.status : null;
  } catch {
    return null;
  }
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// A small typed client for the parts of the Google Calendar v3 REST API Epiphany uses. Reads are
// retried with bounded exponential backoff (429 and rateLimitExceeded honor Retry-After); a create
// or update whose outcome is unknown is never retried blindly but reported as UncertainWriteError.
export function createGoogleCalendarClient(options: GoogleClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const backoff = (attempt: number, hint: number | null) =>
    Math.min(maxDelay, hint ?? baseDelay * 2 ** attempt * (0.5 + random() / 2));

  async function request(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const url = new URL(`${CALENDAR_API}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const idempotent = IDEMPOTENT.has(method);
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const token = await options.getAccessToken({ forceRefresh: refreshed });
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (!idempotent) throw new UncertainWriteError(error);
        if (attempt + 1 >= maxAttempts)
          throw new GoogleApiError(0, "network", "Could not reach Google Calendar.");
        await sleep(backoff(attempt, null));
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        try {
          return await response.json();
        } catch {
          if (!idempotent) throw new UncertainWriteError();
          throw new GoogleApiError(
            response.status,
            "unreadable",
            "Google returned an unreadable response.",
          );
        }
      }

      const status = response.status;
      if (status === 401) {
        if (!refreshed) {
          refreshed = true;
          attempt--;
          continue;
        }
        throw new GoogleAuthError(status, null);
      }

      const reason = await readError(response);
      const limited =
        status === 429 || (status === 403 && reason && RATE_LIMIT_REASONS.has(reason));
      if (limited) {
        const hint = retryAfterMs(response);
        if (attempt + 1 >= maxAttempts) throw new GoogleRateLimitError(status, reason, hint);
        await sleep(backoff(attempt, hint));
        continue;
      }
      if (status >= 500) {
        if (!idempotent) throw new UncertainWriteError();
        if (attempt + 1 >= maxAttempts) throw new GoogleApiError(status, reason);
        await sleep(backoff(attempt, retryAfterMs(response)));
        continue;
      }
      if (status === 410) throw new GoogleGoneError(reason);
      if (status === 412) throw new GooglePreconditionError();
      if (status === 404) throw new GoogleNotFoundError();
      if (status === 409) throw new GoogleConflictError();
      if (status === 403 || status === 400) throw new GoogleApiError(status, reason);
      throw new GoogleApiError(status, reason);
    }
  }

  function parseEvent(value: unknown): GoogleEvent {
    const parsed = googleEventSchema.safeParse(value);
    if (!parsed.success)
      throw new GoogleApiError(200, "unexpected_shape", "Unexpected event data from Google.");
    return parsed.data;
  }

  const calendarPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}`;
  const eventPath = (calendarId: string, eventId: string) =>
    `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;

  return {
    async listCalendars(): Promise<GoogleCalendarEntry[]> {
      const out: GoogleCalendarEntry[] = [];
      let pageToken: string | undefined;
      do {
        const body = (await request("GET", "/users/me/calendarList", {
          query: { maxResults: "250", minAccessRole: "reader", pageToken },
        })) as { items?: unknown[]; nextPageToken?: string };
        for (const item of body.items ?? []) {
          const entry = item as Record<string, unknown>;
          if (typeof entry.id !== "string" || entry.deleted === true) continue;
          out.push({
            id: entry.id,
            summary:
              typeof entry.summaryOverride === "string"
                ? entry.summaryOverride
                : typeof entry.summary === "string"
                  ? entry.summary
                  : entry.id,
            timeZone: typeof entry.timeZone === "string" ? entry.timeZone : null,
            accessRole: typeof entry.accessRole === "string" ? entry.accessRole : null,
            primary: entry.primary === true,
          });
        }
        pageToken = body.nextPageToken;
      } while (pageToken);
      return out;
    },

    // One page of events. With syncToken only changes since then are returned (Google forbids a
    // time window then); a 410 means the token is dead and the caller must run a full sync.
    async listEventsPage(
      calendarId: string,
      query: {
        syncToken?: string;
        timeMin?: string;
        timeMax?: string;
        pageToken?: string;
        privateExtendedProperty?: string;
      },
    ): Promise<EventPage> {
      const body = (await request("GET", `${calendarPath(calendarId)}/events`, {
        query: {
          maxResults: "250",
          singleEvents: "true",
          showDeleted: "true",
          syncToken: query.syncToken,
          timeMin: query.syncToken ? undefined : query.timeMin,
          timeMax: query.syncToken ? undefined : query.timeMax,
          pageToken: query.pageToken,
          privateExtendedProperty: query.privateExtendedProperty,
        },
      })) as { items?: unknown[]; nextPageToken?: string; nextSyncToken?: string };
      const events: GoogleEvent[] = [];
      let skipped = 0;
      for (const item of body.items ?? []) {
        const parsed = googleEventSchema.safeParse(item);
        if (parsed.success) events.push(parsed.data);
        else skipped++;
      }
      return {
        events,
        nextPageToken: body.nextPageToken ?? null,
        nextSyncToken: body.nextSyncToken ?? null,
        skipped,
      };
    },

    // Follows every page. The sync token only appears on the last page.
    async listAllEvents(
      calendarId: string,
      query: { syncToken?: string; timeMin?: string; timeMax?: string; maxPages?: number },
    ): Promise<{ events: GoogleEvent[]; nextSyncToken: string | null; skipped: number }> {
      const events: GoogleEvent[] = [];
      let skipped = 0;
      let pageToken: string | undefined;
      for (let page = 0; page < (query.maxPages ?? 40); page++) {
        const result = await this.listEventsPage(calendarId, { ...query, pageToken });
        events.push(...result.events);
        skipped += result.skipped;
        if (!result.nextPageToken) {
          return { events, nextSyncToken: result.nextSyncToken, skipped };
        }
        pageToken = result.nextPageToken;
      }
      throw new GoogleApiError(
        200,
        "too_many_pages",
        "Google returned too many pages to read at once.",
      );
    },

    async getEvent(calendarId: string, eventId: string): Promise<GoogleEvent> {
      return parseEvent(await request("GET", eventPath(calendarId, eventId)));
    },

    // Finds an event Epiphany wrote by its private idempotency key, for reconciling a write whose
    // outcome is unknown.
    async findEventByKey(calendarId: string, key: string): Promise<GoogleEvent | null> {
      const result = await this.listEventsPage(calendarId, {
        privateExtendedProperty: `${EPIPHANY_KEY_PROPERTY}=${key}`,
      });
      return (
        result.events.find((event) => event.status !== "cancelled") ?? result.events[0] ?? null
      );
    },

    async insertEvent(calendarId: string, body: GoogleEventBody): Promise<GoogleEvent> {
      return parseEvent(await request("POST", `${calendarPath(calendarId)}/events`, { body }));
    },

    // Conditional on the ETag: Google answers 412 (GooglePreconditionError) if the event changed.
    async updateEvent(
      calendarId: string,
      eventId: string,
      body: GoogleEventBody,
      etag: string,
    ): Promise<GoogleEvent> {
      return parseEvent(
        await request("PUT", eventPath(calendarId, eventId), {
          body,
          headers: { "If-Match": etag },
        }),
      );
    },

    async deleteEvent(calendarId: string, eventId: string, etag: string): Promise<void> {
      await request("DELETE", eventPath(calendarId, eventId), { headers: { "If-Match": etag } });
    },

    async insertCalendar(body: {
      summary: string;
      description?: string;
      timeZone?: string;
    }): Promise<{ id: string; summary: string }> {
      const created = (await request("POST", "/calendars", { body })) as {
        id?: unknown;
        summary?: unknown;
      };
      if (typeof created.id !== "string") {
        throw new GoogleApiError(200, "unexpected_shape", "Unexpected calendar data from Google.");
      }
      return {
        id: created.id,
        summary: typeof created.summary === "string" ? created.summary : body.summary,
      };
    },

    async calendarExists(calendarId: string): Promise<boolean> {
      try {
        await request("GET", calendarPath(calendarId));
        return true;
      } catch (error) {
        if (error instanceof GoogleNotFoundError) return false;
        throw error;
      }
    },
  };
}

export type GoogleCalendarClient = ReturnType<typeof createGoogleCalendarClient>;
