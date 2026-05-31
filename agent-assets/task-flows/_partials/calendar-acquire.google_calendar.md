---
name: calendar-acquire.google_calendar
description: Acquire a Google Calendar event window per <acquisition-plan> row.
spec: docs/design/appendices/routine-data-acquisition.md §6.8 / §8.3
---

# Google Calendar acquisition

For every `<fetch integration="google_calendar" ...>` row in
`<acquisition-plan>`, take the branch below that matches the row's `mode`
attribute. Calendar rows do not fan out per account today — the dispatcher
emits one row per active provider, scoped to the bound primary calendar.

Note on coverage: routines whose calendar window is already covered by
`ContextBuilder.buildCalendarBlock` (the `<calendar_events_*>` blocks) do
**not** appear in the pre-pass plan for the same window — that would
double-fetch. The catalog only emits drift / retrospective / imminent
windows for the pre-pass.

Submit every returned event — for a whole window in **one** call — via the
`mcp__aitne-observations__submit_observations` MCP tool when it is in your
allowed tools (preferred — the structured MCP transport carries
Unicode-bearing titles / attendee names that would deterministically trip
`curl … -d '{…}'` on the SDK's bash preflight). Build the tool input as
`{"observations":[…]}` with one entry per event.

If the MCP tool is unavailable (non-Claude session backend), fall back to
`POST http://localhost:8321/api/observations/batch` with the same envelope:

```json
{"observations":[
  {"source":"google_calendar:<calendarId>","ref":"<eventId>","changeType":"created","actor":"agent",
   "payload":{"kind":"calendar","providerId":"<calendarId>","raw":{"title":"…","start":"…","end":"…","attendees":[…],"status":"…"}}},
  …
]}
```

Field rules per element:

- `source`     = `"google_calendar:<calendarId>"` (use `"primary"` when the
  provider returns no explicit id)
- `ref`        = provider-side stable event id
- `changeType` = `"created"` for fresh events; `"modified"` when the
  payload updates an existing `(source, ref)`; `"deleted"` for cancelled
  events (payload = `{ "kind": "calendar", "providerId": "<calendarId>",
  "raw": { "deletedAt": "<iso>" } }`)
- `actor`      = `"agent"`
- `payload`    = `{ "kind": "calendar", "providerId": "<calendarId>",
                    "raw": { "title": ..., "start": ..., "end": ...,
                             "attendees": [...], "status": ... } }`

Server computes the dedup hash from `(source, payload)`. The MCP tool and
the batch endpoint return the same envelope: `{ "results": [...],
"fetched": N, "posted": N, "duplicates": N, "errors": N }`. Per-item
`results[*].status`:

- `"created"` / `"modified"` — rolled into `posted`.
- `"duplicate"` — rolled into `duplicates`.
- `"flip_locked"` — append `{type:"flip-locked","integration":"google_calendar"}`
  to `errors` and continue.
- `"validation_error"` — append `{type:"validation-error","integration":"google_calendar","ref":"<ref>","detail":"<results[*].error>"}`
  to `errors` and continue.

Cap each batch at 200 entries — split the window into multiple
`submit_observations` (or POST) calls if the upstream returns more than that.

<!-- mode:direct:google_calendar -->
GET `http://localhost:8321/api/calendar/events<query>` where `<query>` is
the literal `query` attribute of the `<fetch>` row (e.g.
`?date=2026-05-11&days=1` or `?date=2026-05-04&days=7`). The route
accepts `date=YYYY-MM-DD` (or `today`) plus `days=N` (≤90); `timeMin`
/ `timeMax` are NOT recognised. The daemon returns `{ "events": [...] }`;
map every event into the `observations[]` array of a single
`submit_observations` MCP tool call (or `POST /api/observations/batch`
fallback).
<!-- /mode:direct:google_calendar -->

<!-- mode:delegated-same:google_calendar -->
The connector is bound to your own session backend. Use the in-session
connector surface your skills document; the `<fetch>` row's `query`
attribute carries the catalog's `delegated` form (e.g.
`timeMin="..." timeMax="..." maxResults=50`). Translate it into the args
your bound surface accepts. POST every returned event as specified above.
<!-- /mode:delegated-same:google_calendar -->

<!-- mode:delegated-cross:google_calendar -->
The connector is bound to a different backend than this session — reach
it through the daemon's delegation proxy. POST to
`http://localhost:8321/api/integrations/google_calendar/exec` with the
following body (substitute the row's `query` into `task`):

```json
{
  "task": "List Google Calendar events for the window <query>. Return id, title, start, end, attendees (email + responseStatus), and status. Up to 100 events.",
  "outputSchema": {
    "type": "object",
    "required": ["events"],
    "properties": {
      "events": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["id"],
          "properties": {
            "id":     { "type": "string" },
            "title":  { "type": "string" },
            "start":  { "type": "string" },
            "end":    { "type": "string" },
            "status": { "type": "string" },
            "attendees": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "email":          { "type": "string" },
                  "responseStatus": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  },
  "maxToolCalls": 3,
  "cacheable": true
}
```

Map all items in `result.events[]` into a single `submit_observations`
MCP tool call (or `POST /api/observations/batch` fallback).
<!-- /mode:delegated-cross:google_calendar -->

<!-- mode:native:google_calendar -->
The connector is bound natively to your own session backend. Use the
in-session connector surface your skills document — same call shape as
`delegated-same`. The daemon does not proxy. POST every returned event as
specified above.
<!-- /mode:native:google_calendar -->

<!-- mode:disabled:google_calendar -->
Defensive no-op. The dispatcher filters disabled integrations out of
`<acquisition-plan>`. If a `<fetch integration="google_calendar">` row
still reaches this branch, skip it and append
`{"type":"unexpected-row","integration":"google_calendar","reason":"disabled-row-emitted"}`
to your `errors` array.
<!-- /mode:disabled:google_calendar -->
