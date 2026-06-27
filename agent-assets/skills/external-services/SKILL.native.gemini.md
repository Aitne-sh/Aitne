---
name: external-services
description: Load when an external-services surface is in scope and Google Calendar is in native mode bound to Gemini (`nativeBackend === "gemini"`). Calendar runs via the Gemini Calendar connector; daemon does not proxy. Obsidian, GitHub, scheduling, Skills CRUD keep direct routes.
allowed-tools:
  - Bash(curl *)
  - Read
---

# External Services — Native Mode (in-session Calendar connector)

Base URL: `http://localhost:8321`. All daemon calls via `curl -s` with
`Content-Type: application/json` on POST/PATCH/PUT.

> **Refusal directive — read first.** Google Calendar is in `native`
> mode bound to Gemini. Do **NOT** call any of:
>
> - `/api/calendar/*` (route-prefix 410)
> - `POST /api/integrations/google_calendar/exec`
> - `POST /api/integrations/google_calendar/reconcile`
>
> In native mode `POST /api/integrations/google_calendar/exec` returns
> **409 `mode_mismatch`** (the handler rejects non-delegated mode);
> `.../reconcile` is not mode-gated at all. Do not call either — use the
> native connector. The 410 + `X-Integration-Mode: native` refusal
> contract applies ONLY to the integration's own data routes
> (`/api/calendar/*`).
>
> Reach Google Calendar through the in-session Google Calendar
> connector your harness exposes (typically Gemini CLI's
> `google-workspace` extension). Your tool menu lists every available
> tool at session start — pick the Calendar one.
>
> Only **Google Calendar** is integration-gated here. Apple Calendar,
> Outlook Calendar, Obsidian, GitHub, scheduling, and Skills CRUD
> remain direct-mode routes.

Confirm the binding via `<integration_modes>` (`google_calendar="native"`)
and the `<integration-routing-table>` block in the session preamble.

## Source of Truth (READ FIRST)

Same files as the direct-mode body — `policies/management.md` →
`## Source of Truth` and `~/.personal-agent/integrations.md` →
`## Note Sources`. If Schedule != Google Calendar, route through the
provider-specific direct route (`/api/apple-calendar/*` or
`/api/calendar/outlook/*`); the native binding is irrelevant.

## Shell rules

`jq`, never `python3`. `curl` restricted to `http://localhost:8321`.

---

<!-- service:calendar -->
## Google Calendar — in-session connector

The exact tool names depend on which Calendar connector your harness
has loaded. Inspect your tool menu at session start and pick the
matching capability. Gemini CLI's `google-workspace` extension is the
typical provider here; rely on the capability classes below rather
than specific tool names.

### Read-class capabilities

| Capability | What to do |
|---|---|
| `list_events` | Window-list events on a calendar (`calendarId` + `timeMin` / `timeMax`). |
| `get_event` | Single-event read by id. |
| `list_calendars` | Enumerate the user's calendars (the `primary: true` flag identifies the default). |
| `find_free_time` | Free-slot proposal — pure compute. |

Canonical list flow: invoke your connector's list-events function with
`calendarId="primary"`, `timeMin` / `timeMax` as ISO-8601 timestamps
with TZ offset, and (if supported) `maxResults=50`.

**Gemini-specific Calendar quirks** (typical of the
`google-workspace` extension; verify against your connector's actual
behavior):

| Quirk | Effect | Workaround |
|---|---|---|
| `maxResults` silently ignored on list-events | Result set bounded only by the time window + connector default | Narrow the time window when the connector returns more than expected; do not assume the cap applies. |
| Default `attendeeResponseStatus = ["accepted","tentative","needsAction"]` drops declined events | Declined meetings invisible | Pass `attendeeResponseStatus=["declined"]` or the full set explicitly when needed. |

Canonical detail read (always GET-before-PATCH): invoke the
get-event function with `calendarId` and the `eventId` returned by
list.

### Destructive capabilities (require explicit user confirmation)

Per the registry's
`google_calendar.backendConnectors.gemini.destructiveTools`, the
following capability classes are destructive in native:gemini mode:

- **Create event** — adds a new event.
- **Update event** — mutates an existing event (attendees whole-list
  replacement; see warning below).
- **Delete event** — removes the event.
- **Respond to event** — dispatches an RSVP.

Apply the destructive-confirm contract every time. The starter
`deniedTools` list is enforced before the call lands.

**ATTENDEES WARNING.** The update-event capability replaces the
attendees array verbatim. To add one attendee:

1. Read the event → copy `attendees`.
2. Append the new attendee.
3. Update with the full attendees list.

**Recurring events.** Single-instance edits require the instance id;
master-id update shifts the whole series. Confirm scope.

### Time discipline

ISO 8601 with TZ offset for timed events; `YYYY-MM-DD` for all-day.
Connectors typically reject naked-ISO inputs.

### Imminent-event reminders (activity_scan)

The activity_scan native variant's Step 0b drives the imminent-window
fetch each hour; this skill describes the per-call surface. POST each
materialised event to `/api/observations` per the section below.

<!-- /service:calendar -->

---

<!-- service:apple-calendar -->
## Apple Calendar (iCloud CalDAV) — direct, unchanged

Use `/api/apple-calendar/*` per the direct-mode body if
`policies/management.md` Schedule = Apple Calendar.
<!-- /service:apple-calendar -->

---

<!-- service:outlook-calendar -->
## Outlook Calendar (Microsoft Graph) — direct, unchanged

Use `/api/calendar/outlook/*` per the direct-mode body if Schedule =
Outlook Calendar. No Outlook MCP connector ships for Gemini today.
<!-- /service:outlook-calendar -->

---

<!-- service:obsidian -->
## Obsidian (external vault) — direct, unchanged

`/api/obsidian/*` per the direct-mode body. Requires the Obsidian app
running. Never use this skill to read or write the agent's primary
management vault.

```bash
curl -s http://localhost:8321/api/obsidian/status
curl -s "http://localhost:8321/api/obsidian/search?q=meeting+notes&limit=10"
curl -s http://localhost:8321/api/obsidian/notes/Daily%20Notes/2026-04-06
curl -s -X POST http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"name": "Meeting Notes 2026-04-02", "content": "# Meeting\n..."}'
curl -s -X PUT http://localhost:8321/api/obsidian/notes/Projects/ProjectA \
  -H 'Content-Type: application/json' -d '{"content": "# Full body"}'
curl -s -X PATCH http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"file": "Meeting Notes 2026-04-02", "content": "\n- Action item"}'
curl -s -X PATCH http://localhost:8321/api/obsidian/daily \
  -H 'Content-Type: application/json' -d '{"content": "- [ ] Follow up"}'
curl -s -X DELETE http://localhost:8321/api/obsidian/notes/Projects/Old
```
<!-- /service:obsidian -->

---

<!-- service:github -->
## GitHub — direct, unchanged

```bash
curl -s http://localhost:8321/api/github/repos
curl -s "http://localhost:8321/api/github/pulls?owner=user&repo=repo&state=open"
curl -s -X POST http://localhost:8321/api/github/pulls/comment \
  -H 'Content-Type: application/json' \
  -d '{"owner": "user", "repo": "repo", "pull_number": 42, "comment": "LGTM"}'
```
<!-- /service:github -->

---

<!-- service:notion -->
## Notion

Load the dedicated `notion` skill — its body picks the right variant
from the session's integration state independently of Calendar.
<!-- /service:notion -->

---

## Persisting Calendar observations from native fetches

**Batch when you have more than one event.** Use
`POST /api/observations/batch` with up to 200 items in one
`observations[]` array (see the `observations` skill for the envelope).
The single-item form below is for the rare "one new event surfaced"
case.

```bash
curl -s -X POST http://localhost:8321/api/observations \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "google_calendar:<calendarId>",
    "ref": "<eventId>",
    "changeType": "created",
    "actor": "agent",
    "payload": <verbatim connector event object>
  }'
```

The daemon computes `contentHash` server-side. Pass the raw `payload`.
`actor` MUST be `"agent"` or `"system"` — the server rejects `"user"`.
HTTP 409 indicates a mode-flip race window (§11.3.1); stop and re-read
`<integration_modes>`.

---

## Scheduling — direct, unchanged

`/api/schedule`, `/api/schedule/dm`, `/api/recurring-schedules` live
in the `schedule` skill. Native-mode gating does not apply.

## Skills Management — direct, unchanged

`/api/skills` CRUD per the direct-mode body. Native-mode gating does
not apply.

## Cost / audit

Native MCP calls land `agent_actions` rows of type `mcp_call` with
`provider="gemini"`, the tool name, and the parent `event_id` /
`processKey`. The cost dashboard joins these to the registry by
`toolNamespace` prefix (§14.4 `nativeAttribution`).
