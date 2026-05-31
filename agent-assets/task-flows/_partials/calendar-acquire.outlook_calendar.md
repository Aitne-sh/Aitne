---
name: calendar-acquire.outlook_calendar
description: Acquire an Outlook Calendar event window per <acquisition-plan> row.
spec: docs/design/appendices/routine-data-acquisition.md §6.8 / §8.4
---

# Outlook Calendar acquisition

For every `<fetch integration="outlook_calendar" ...>` row in
`<acquisition-plan>`, take the branch below that matches the row's `mode`
attribute. Calendar rows do not fan out per account today — the dispatcher
emits one row per active provider, scoped to the bound primary calendar.

Outlook Calendar is a **user-managed** integration: the daemon has no
delegation proxy (no `/api/integrations/outlook_calendar/exec` exists).
The four non-disabled branches therefore split into two real flows:

- `direct` → the daemon's Outlook calendar route
  (`/api/calendar/outlook/events`).
- `delegated-same`, `delegated-cross`, `native` → use the in-session
  connector surface your skills document. The user picks the binding (an
  in-session connector, a local CLI invoked via a skill, a custom
  script); the partial states the intent, not specific tool names. If no
  surface is bound, record an error and continue.

Note on coverage: when `ContextBuilder.buildCalendarBlock` already covers
the window via `<calendar_events_*>` (multi-provider after §6.6), the
catalog skips the pre-pass row to avoid double-fetching. The pre-pass
only ships drift / retrospective / imminent windows.

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
  {"source":"outlook_calendar:<calendarId>","ref":"<eventId>","changeType":"created","actor":"agent",
   "payload":{"kind":"calendar","providerId":"<calendarId>","raw":{"title":"…","start":"…","end":"…","attendees":[…],"status":"…"}}},
  …
]}
```

Field rules per element:

- `source`     = `"outlook_calendar:<calendarId>"` (use `"primary"` when
  the provider returns no explicit id)
- `ref`        = provider-side stable event id
- `changeType` = `"created"` for fresh events; `"modified"` when the
  payload updates an existing `(source, ref)`; `"deleted"` for cancelled
  events
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
- `"flip_locked"` — append `{type:"flip-locked","integration":"outlook_calendar"}`
  to `errors` and continue.
- `"validation_error"` — append `{type:"validation-error","integration":"outlook_calendar","ref":"<ref>","detail":"<results[*].error>"}`
  to `errors` and continue.

Cap each batch at 200 entries — split the window into multiple
`submit_observations` (or POST) calls if the upstream returns more than that.

<!-- mode:direct:outlook_calendar -->
GET `http://localhost:8321/api/calendar/outlook/events<query>` where
`<query>` is the literal `query` attribute of the `<fetch>` row (e.g.
`?date=2026-05-11&days=1` or `?date=2026-05-04&days=7`). The route
accepts `date=YYYY-MM-DD` (or `today`) plus `days=N` (≤90); `timeMin`
/ `timeMax` are NOT recognised. The daemon returns
`{ "events": [...] }`; map every event into the `observations[]` array
of a single `submit_observations` MCP tool call (or `POST
/api/observations/batch` fallback).
<!-- /mode:direct:outlook_calendar -->

<!-- mode:delegated-same:outlook_calendar -->
The integration is bound to your own session backend. Use the in-session
connector surface your skills document for Outlook Calendar; the
`<fetch>` row's `query` attribute carries the catalog's `delegated` form
(e.g. `startDateTime=... endDateTime=...`). Translate it into the args
your bound surface accepts. POST every returned event as specified above.

If no Outlook Calendar surface is bound, append
`{"type":"no-surface","integration":"outlook_calendar"}` to your `errors`
array and continue with the next row. Do NOT halt the pre-pass.
<!-- /mode:delegated-same:outlook_calendar -->

<!-- mode:delegated-cross:outlook_calendar -->
Outlook Calendar is user-managed, so the daemon does not host a
delegation proxy. The dispatcher should not have emitted a
`delegated-cross` row for this integration — if you see one, treat it
exactly like `delegated-same`: use whichever in-session connector
surface your skills document for Outlook Calendar. If nothing is bound,
append `{"type":"no-surface","integration":"outlook_calendar"}` to
`errors` and continue.
<!-- /mode:delegated-cross:outlook_calendar -->

<!-- mode:native:outlook_calendar -->
The integration is bound natively to your own session backend. Use the
in-session connector surface your skills document — same call shape as
`delegated-same`. The daemon does not proxy. POST every returned event as
specified above.

If no Outlook Calendar surface is bound, append
`{"type":"no-surface","integration":"outlook_calendar"}` to `errors` and
continue.
<!-- /mode:native:outlook_calendar -->

<!-- mode:disabled:outlook_calendar -->
Defensive no-op. The dispatcher filters disabled integrations out of
`<acquisition-plan>`. If a `<fetch integration="outlook_calendar">` row
still reaches this branch, skip it and append
`{"type":"unexpected-row","integration":"outlook_calendar","reason":"disabled-row-emitted"}`
to your `errors` array.
<!-- /mode:disabled:outlook_calendar -->
