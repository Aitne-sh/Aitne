---
kind: reference
name: calendar-google
description: Google Calendar direct-mode reference — list/get/create/update/delete events, list calendars, free-busy. ATTENDEES PATCH replaces the whole list. Stripped by the integration-mode filter when `google_calendar !== "direct"`.
---

<!-- service:calendar -->
## Calendar

Google Calendar proxy. Operates on the user's primary calendar (configurable via `calendarId` param).

**Timezone rule**: Always include a TZ offset in `start`/`end` dateTime values (e.g. `-04:00`). All-day events use `YYYY-MM-DD` (no TZ needed).

**Event status**: GET returns deleted events with `status: "cancelled"` (200, not 404). Always check `status` before acting. The list endpoint automatically excludes cancelled events.

### List events
```bash
curl -s "http://localhost:8321/api/calendar/events?date=today&days=3"
```

### Get event detail
```bash
curl -s "http://localhost:8321/api/calendar/events/abc123eventid"
```
**Always GET before PATCH** to see current state and attendees.

### Create event (write — Autonomous)
```bash
curl -s -X POST "http://localhost:8321/api/calendar/events" \
  -H 'Content-Type: application/json' \
  -d '{"summary": "Team meeting", "start": "2026-04-02T14:00:00-04:00", "end": "2026-04-02T15:00:00-04:00"}'
```
Optional: `description`, `location`, `reminders`, `recurrence`, `attendees`, `visibility`. All-day: `YYYY-MM-DD`. Attendees: add `?sendUpdates=all` to notify. RRULE: `RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR`.

### Update event (write — Autonomous; commonly on the starter denylist)
```bash
curl -s -X PATCH "http://localhost:8321/api/calendar/events/abc123" \
  -H 'Content-Type: application/json' \
  -d '{"start": "2026-04-02T15:00:00-04:00", "end": "2026-04-02T16:00:00-04:00"}'
```
For recurring events, use the instance ID to update a single occurrence — never PATCH the master.

**ATTENDEES WARNING**: PATCH with `attendees` **replaces the entire list** — it does NOT append. To add one attendee: (1) GET, (2) copy existing, (3) add new, (4) PATCH full list.

### Delete event (write — Autonomous; default starter denylist denies it)
```bash
curl -s -X DELETE "http://localhost:8321/api/calendar/events/abc123"
```
Add `?sendUpdates=all` to notify attendees. Do NOT PATCH a cancelled event.

### List calendars
```bash
curl -s http://localhost:8321/api/calendar/calendars
```

### Free/busy query
```bash
curl -s -X POST http://localhost:8321/api/calendar/freebusy \
  -H 'Content-Type: application/json' \
  -d '{"timeMin": "2026-04-11T09:00:00-04:00", "timeMax": "2026-04-11T18:00:00-04:00"}'
```

### Calendar error envelope (direct mode)

| HTTP | `error` | What it means / what to do |
|---|---|---|
| 400 | `validation_error` | Bad request shape (e.g. missing `start`/`end`, malformed RRULE). Fix and retry. |
| 404 | `not_found` | Event id unknown or already deleted. Re-list before retrying. |
| 410 | `integration_delegated` | Calendar flipped to delegated mode mid-session. This skill body is direct-only — re-read `integrations.md` and use `POST /api/integrations/google_calendar/exec` (cross-backend task mode) or your session backend's native Calendar MCP (the same-backend variant) instead. |
| 502 | `calendar_error` | Upstream Google API error — `message` carries the API's text. Surface verbatim; do not retry unless clearly transient. |
| 503 | `calendar_not_configured` | Direct OAuth credentials are missing or the user has disabled Calendar in settings. Tell the user and stop. |
<!-- /service:calendar -->
