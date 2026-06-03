---
kind: reference
name: calendar-apple
description: Apple Calendar (iCloud CalDAV) reference — list/get/create/update/delete with recurring-instance gotchas, app-specific-password setup probe, no proactive notifications. Stripped when `apple_calendar` is not configured.
---

<!-- service:apple-calendar -->
## Apple Calendar (iCloud CalDAV)

Use this section **only when `policies/management.md` Schedule = Apple Calendar**. The provider-routing table at the top of this skill is non-negotiable.

The route shape mirrors `/api/calendar/*` so prose patterns transfer: list → get → patch / create / delete. Differences are flagged below.

### Probe configuration before first use
```bash
curl -s http://localhost:8321/api/apple-calendar/status
# → { "configured": bool, "available": bool }
```
- `configured: false` → user has not entered Apple ID + app-specific password yet. Tell the user to open the dashboard's Apple Calendar card (Connections page) and paste a password from `appleid.apple.com` → Sign-In and Security → App-Specific Passwords. **Do not try to read or write events** until `available: true`.
- `configured: true, available: false` → credentials are stored but iCloud rejected the last connection. Surface verbatim; common cause is the user revoked the app-specific password.

### List events
```bash
curl -s "http://localhost:8321/api/apple-calendar/events?date=today&days=3"
```
Same query params as Google: `date` (`YYYY-MM-DD` or `today`), `days` (max 90). Returns `{ events: [...] }` with the same JSON shape used by the Google route — `id`, `summary`, `start`, `end`, `location`, `description`, `allDay`, `status`, plus two Apple-specific fields:
- `recurring` (bool) — true for any event in a recurring series.
- `recurrenceId` (string|null) — populated for an expanded instance of a series.

For a recurring instance the `id` is `<UID>__<RECURRENCE-ID>` so you can address a specific occurrence.

**Timezones**: dateTime values are emitted in UTC (`Z` suffix). Convert to the user's local timezone before showing them.

### Get event detail
```bash
curl -s "http://localhost:8321/api/apple-calendar/events/<id>"
```
Always GET before PATCH so you see the current summary/start/end.

### Create event (write — Autonomous)
```bash
curl -s -X POST http://localhost:8321/api/apple-calendar/events \
  -H 'Content-Type: application/json' \
  -d '{"summary": "Team meeting", "start": "2026-04-26T14:00:00+09:00", "end": "2026-04-26T15:00:00+09:00"}'
```
Optional: `description`, `location`. **[Apple only]** `attendees`, `reminders`, `recurrence`, `visibility` from the Google shape are **rejected** — the Apple schema is `.strict()`, so including any of them fails the whole request with `400 validation_error` and no event is created (the same applies to PATCH). iCloud invitations and reminder defaults belong to the user's Apple ID and the agent should not author them. If a user asks for those, tell them and stop — do not include the fields in the request.

### Update event (write — Autonomous)
```bash
curl -s -X PATCH http://localhost:8321/api/apple-calendar/events/<id> \
  -H 'Content-Type: application/json' \
  -d '{"start": "2026-04-26T15:00:00+09:00", "end": "2026-04-26T16:00:00+09:00"}'
```

**[Apple only] Recurring-event editing semantics — read before writing**
- A composite id (one whose suffix matches `__YYYY-MM-DD…`) addresses **one occurrence** of a series. PATCH/DELETE on it returns `501 recurring_instance_unsupported`. To move a single occurrence the user must edit it from Calendar.app.
- A bare id whose GET returned `recurring: true` is the **series master**. PATCH on the master shifts the **entire series** (every future occurrence moves), and DELETE removes the entire series. Confirm with the user that they intend a series-level edit before issuing the call — agents have historically read "PATCH this event's start" as a single-instance reschedule, which is wrong here.
- A bare id with `recurring: false` is a normal one-off event — PATCH/DELETE behave as usual.
- `summary`, `start`, and `end` may be updated independently. Toggling all-day-ness (`YYYY-MM-DD` ↔ `…T…Z`) requires providing **both** `start` and `end` in the same PATCH; the codec rejects partial all-day toggles with `400 validation_error`.
- Time strings must include a TZ offset (`Z` or `±HH:MM`); naked ISO without offset returns `400 validation_error` — do not interpret a user-stated time as local without an explicit offset.

### Delete event (write — Autonomous)
```bash
curl -s -X DELETE http://localhost:8321/api/apple-calendar/events/<id>
```
Same recurring semantics as PATCH (see the rules block above).

### List calendars
```bash
curl -s http://localhost:8321/api/apple-calendar/calendars
# → { "calendars": [{ id, summary, description, primary }, ...] }
```
The `id` is an opaque CalDAV URL. The user's primary calendar is marked `primary: true`. To change which calendar create/list reads, see the dashboard Apple Calendar card.

### Free/busy query
```bash
curl -s -X POST http://localhost:8321/api/apple-calendar/freebusy \
  -H 'Content-Type: application/json' \
  -d '{"timeMin": "2026-04-26T09:00:00Z", "timeMax": "2026-04-26T18:00:00Z"}'
```
**[Apple only]** Free-busy is derived from `listEvents` — events with `status: "cancelled"` are excluded. `calendarIds` is ignored (the primary calendar is the only target).

### Apple Calendar error envelope

| HTTP | `error` | What it means / what to do |
|---|---|---|
| 400 | `validation_error` | Bad request shape. Fix and retry. |
| 401 | `auth_failed` | iCloud rejected the credentials. Tell the user to refresh the app-specific password in the dashboard. |
| 404 | `not_found` | Event id unknown or already deleted. Re-list before retrying. |
| 501 | `recurring_instance_unsupported` | The id targets a single occurrence of a recurring series — see the PATCH/DELETE notes above. |
| 502 | `apple_calendar_error` | Upstream iCloud / CalDAV error. `message` carries the wire text. |
| 503 | `apple_calendar_not_configured` | Credentials missing or last connection failed. Run the status probe above. |

### Known gap: no proactive notifications

The hourly polling pivot (`schedule.approaching` events, observation deltas) only fires for Google Calendar today. With Apple Calendar selected, on-demand DM queries work but the agent will not proactively warn about an imminent event — the user's own iOS / macOS Calendar.app notifications fill that gap.
<!-- /service:apple-calendar -->
