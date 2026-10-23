# Microsoft calendars (Goal 23): feasibility and supported alternatives

**Status: investigated, not connected.** Whether Epiphany can read the Outlook/Exchange calendar behind
Teams depends on a policy decision that only the Microsoft tenant's administrators can make. This page
records what is known, how to find out, and what works either way. The integration is deliberately not
marked complete.

## What would be needed for direct access

Direct access uses Microsoft Graph (`/me/calendarView`) with OAuth. It needs:

1. An app registration in Microsoft Entra ID with the delegated permission `Calendars.Read` (read only;
   `Calendars.ReadWrite` is not needed and should not be requested).
2. The user to consent. In many school and employer tenants, **users are not allowed to consent to
   third-party apps**; the sign-in then shows "Need admin approval" and an administrator has to approve the
   app (or a verified-publisher policy applies). Conditional-access rules and managed-device requirements can
   also block sign-in from a personal app.

## How to find out (about five minutes)

1. Register a free personal app registration at entra.microsoft.com (or Azure portal > App registrations)
   with the redirect URI `https://<your-app>/api/microsoft/callback` and the `Calendars.Read` permission.
2. Open the consent URL while signed in to the school/work account. Outcomes:
   - **Consent screen appears and you can accept**: direct access is possible. Tell the maintainer and the
     Graph integration can be built on the same pattern as Google (docs/calendar.md).
   - **"Need admin approval"** (or "AADSTS65001"/"AADSTS90094"): blocked by the institution. Do not try to
     work around it. Ask the IT contact whether they will approve the app, or use an alternative below.

## Alternatives that need no administrator

| Option | How it works | Limits |
| --- | --- | --- |
| **Published ICS link** (read only) | In Outlook on the web: Settings > Calendar > Shared calendars > Publish a calendar, choose "Can view all details", copy the ICS link into Epiphany | Many tenants disable publishing. Microsoft refreshes published feeds slowly (up to several hours), so it is **not** suitable for immediate updates or conflict checks that must be exact. Read only |
| **Forward/copy into Google Calendar** | Subscribe or import the Outlook calendar into Google Calendar, then connect Google (Goal 11) | Same refresh delay; one more hop |
| **Add important events by telling Epi** | "I have class Tue/Thu at 9" creates events in Epiphany directly | Manual; no sync |

## Design if access is granted

- One combined availability view: Microsoft events are read into the same `events` table as external events
  with a provider tag and an external id, so the free-time engine sees them next to Google events. Nothing is
  copied back into Google, so there are no duplicates and no sync loops.
- Epiphany never writes to the Microsoft calendar; its work blocks go to the dedicated Epiphany Google
  calendar only.
- Tokens are stored encrypted (same mechanism as Google) and can be revoked at any time from the dashboard.
- Revoked or expired access shows as a visible "reconnect" state, never as an empty calendar.

## What to tell the maintainer

Please report which outcome you got in step 2 above, and (if blocked) whether you want the published-ICS
route built. The ICS reader (a small read-only importer into the same external-event model as Google) is **not built yet**; it can be added once you tell me you want that route.
