import type { GoogleEvent } from "./google/client";

// An in-memory stand-in for the Google Calendar and OAuth endpoints, used only by tests. It keeps
// real semantics where the sync engine depends on them: ETags change on every edit, If-Match is
// enforced (412), sync tokens return only later changes (410 once expired), deleted events remain
// as cancelled tombstones, client-chosen IDs conflict (409), and private extended properties can be
// searched. Requests can be made to fail in the ways Google does (timeouts, 429, 5xx).

export type FakeEvent = GoogleEvent & { seq: number; description?: string };

export interface FakeCalendar {
  id: string;
  summary: string;
  timeZone: string;
  accessRole: string;
  primary: boolean;
  events: Map<string, FakeEvent>;
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  ifMatch: string | null;
}

export type FailureAction =
  | "timeout-before-apply"
  | "timeout-after-apply"
  | { status: number; body?: unknown; headers?: Record<string, string> };

interface Failure {
  match: (call: FakeCall) => boolean;
  action: FailureAction;
  times: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export class FakeGoogle {
  calendars = new Map<string, FakeCalendar>();
  calls: FakeCall[] = [];
  validAccessTokens = new Set<string>();
  revokedTokens: string[] = [];
  refreshCount = 0;
  refreshInvalidGrant = false;
  refreshFailureStatus: number | null = null;
  minValidSeq = 0;
  pageSize = 250;
  private seq = 0;
  private etagCounter = 0;
  private idCounter = 0;
  private tokenCounter = 0;
  private failures: Failure[] = [];

  constructor() {
    this.addCalendar({ id: "owner@example.test", summary: "Owner", primary: true });
  }

  addCalendar(input: { id: string; summary: string; primary?: boolean; accessRole?: string }) {
    const calendar: FakeCalendar = {
      id: input.id,
      summary: input.summary,
      timeZone: "America/Chicago",
      accessRole: input.accessRole ?? "owner",
      primary: input.primary ?? false,
      events: new Map(),
    };
    this.calendars.set(input.id, calendar);
    return calendar;
  }

  private touch(event: FakeEvent) {
    event.seq = ++this.seq;
    event.etag = `"etag-${++this.etagCounter}"`;
    event.updated = new Date(Date.UTC(2026, 9, 1, 0, 0, this.seq)).toISOString();
  }

  // Adds an event the way another person or app would.
  addEvent(calendarId: string, event: Partial<GoogleEvent> & { id?: string }): FakeEvent {
    const full: FakeEvent = {
      status: "confirmed",
      summary: "Event",
      ...event,
      id: event.id ?? `ext${++this.idCounter}`,
      seq: 0,
    };
    this.touch(full);
    this.calendars.get(calendarId)!.events.set(full.id, full);
    return full;
  }

  // An edit made outside Epiphany (for example in the Google Calendar app).
  editEvent(calendarId: string, id: string, patch: Partial<GoogleEvent>) {
    const event = this.calendars.get(calendarId)!.events.get(id)!;
    Object.assign(event, patch);
    this.touch(event);
    return event;
  }

  removeEvent(calendarId: string, id: string) {
    const event = this.calendars.get(calendarId)!.events.get(id)!;
    event.status = "cancelled";
    this.touch(event);
  }

  // The next `times` calls matching `match` fail as described.
  fail(match: (call: FakeCall) => boolean, action: FailureAction, times = 1) {
    this.failures.push({ match, action, times });
  }

  clearCalls() {
    this.calls = [];
  }

  writes() {
    return this.calls.filter((c) => c.method !== "GET" && !c.path.startsWith("oauth"));
  }

  expireSyncTokens() {
    this.minValidSeq = this.seq + 1;
  }

  findCalendarBySummary(summary: string) {
    return [...this.calendars.values()].find((c) => c.summary === summary);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const query = Object.fromEntries(url.searchParams.entries());
    const isOauth = url.hostname === "oauth2.googleapis.com";
    const path = isOauth ? `oauth${url.pathname}` : url.pathname.replace(/^\/calendar\/v3/, "");
    const call: FakeCall = { method, path, query, ifMatch: headers.get("if-match") };
    this.calls.push(call);

    const failure = this.failures.find((f) => f.times > 0 && f.match(call));
    if (failure) {
      failure.times--;
      if (failure.action === "timeout-before-apply") throw new TypeError("fetch failed");
      if (typeof failure.action === "object") {
        return json(failure.action.status, failure.action.body ?? {}, failure.action.headers);
      }
    }

    const response = isOauth ? this.oauth(path, init) : this.api(call, headers, init);
    if (failure?.action === "timeout-after-apply") throw new TypeError("fetch failed");
    return response;
  };

  private oauth(path: string, init: RequestInit): Response {
    const body = new URLSearchParams(String(init.body ?? ""));
    if (path === "oauth/revoke") {
      this.revokedTokens.push(body.get("token") ?? "");
      return json(200, {});
    }
    this.refreshCount++;
    if (this.refreshFailureStatus)
      return json(this.refreshFailureStatus, { error: "backend_error" });
    if (this.refreshInvalidGrant) return json(400, { error: "invalid_grant" });
    const token = `access-${++this.tokenCounter}`;
    this.validAccessTokens.add(token);
    return json(200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
  }

  private api(call: FakeCall, headers: Headers, init: RequestInit): Response {
    const auth = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.validAccessTokens.has(auth)) {
      return json(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    }
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (call.path === "/users/me/calendarList" && call.method === "GET") {
      return json(200, {
        items: [...this.calendars.values()].map((c) => ({
          id: c.id,
          summary: c.summary,
          timeZone: c.timeZone,
          accessRole: c.accessRole,
          primary: c.primary || undefined,
        })),
      });
    }
    if (call.path === "/calendars" && call.method === "POST") {
      const id = `cal-${++this.idCounter}@group.calendar.example.test`;
      this.addCalendar({ id, summary: String(body.summary) });
      return json(200, { id, summary: body.summary });
    }
    const eventsMatch = call.path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    const calendarMatch = call.path.match(/^\/calendars\/([^/]+)$/);
    if (calendarMatch && call.method === "GET") {
      return this.calendars.has(decodeURIComponent(calendarMatch[1]!))
        ? json(200, {})
        : json(404, { error: { code: 404 } });
    }
    if (!eventsMatch) return json(404, { error: { code: 404 } });
    const calendar = this.calendars.get(decodeURIComponent(eventsMatch[1]!));
    if (!calendar) return json(404, { error: { code: 404, status: "NOT_FOUND" } });
    const eventId = eventsMatch[2] ? decodeURIComponent(eventsMatch[2]) : null;
    return eventId
      ? this.singleEvent(calendar, eventId, call, body)
      : this.eventsCollection(calendar, call, body);
  }

  private eventsCollection(
    calendar: FakeCalendar,
    call: FakeCall,
    body: Record<string, unknown>,
  ): Response {
    if (call.method === "POST") {
      const id = typeof body.id === "string" ? body.id : `gen${++this.idCounter}`;
      if (calendar.events.has(id))
        return json(409, { error: { code: 409, status: "ALREADY_EXISTS" } });
      const event: FakeEvent = {
        ...(body as Partial<GoogleEvent>),
        id,
        status: "confirmed",
        seq: 0,
      } as FakeEvent;
      this.touch(event);
      calendar.events.set(id, event);
      return json(200, event);
    }

    const { syncToken, pageToken, privateExtendedProperty, timeMin, timeMax } = call.query;
    let items = [...calendar.events.values()];
    if (syncToken) {
      const since = Number(syncToken.replace("st-", ""));
      if (!syncToken.startsWith("st-") || since < this.minValidSeq) {
        return json(410, {
          error: { code: 410, status: "GONE", errors: [{ reason: "fullSyncRequired" }] },
        });
      }
      items = items.filter((e) => e.seq > since);
    } else {
      if (timeMin) {
        items = items.filter(
          (e) =>
            !e.start ||
            new Date(e.start.dateTime ?? `${e.start.date}T00:00:00Z`) >= new Date(timeMin),
        );
      }
      if (timeMax) {
        items = items.filter(
          (e) =>
            !e.start ||
            new Date(e.start.dateTime ?? `${e.start.date}T00:00:00Z`) < new Date(timeMax),
        );
      }
    }
    if (privateExtendedProperty) {
      const [key, value] = privateExtendedProperty.split("=");
      items = items.filter((e) => e.extendedProperties?.private?.[key!] === value);
    }
    items.sort((a, b) => a.seq - b.seq);
    const offset = pageToken ? Number(pageToken) : 0;
    const page = items.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < items.length;
    return json(200, {
      items: page,
      ...(more
        ? { nextPageToken: String(offset + this.pageSize) }
        : { nextSyncToken: `st-${this.seq}` }),
    });
  }

  private singleEvent(
    calendar: FakeCalendar,
    id: string,
    call: FakeCall,
    body: Record<string, unknown>,
  ): Response {
    const event = calendar.events.get(id);
    if (!event) return json(404, { error: { code: 404, status: "NOT_FOUND" } });
    if (call.method === "GET") return json(200, event);
    if (call.ifMatch && call.ifMatch !== event.etag) {
      return json(412, { error: { code: 412, errors: [{ reason: "conditionNotMet" }] } });
    }
    if (call.method === "PUT") {
      Object.assign(event, body, { id, status: "confirmed" });
      this.touch(event);
      return json(200, event);
    }
    if (call.method === "DELETE") {
      if (event.status === "cancelled") return json(410, { error: { code: 410 } });
      event.status = "cancelled";
      this.touch(event);
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  }
}
