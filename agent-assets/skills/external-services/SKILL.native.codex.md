---
name: external-services
description: Load when an external-services surface is in scope and Google Calendar is in native mode bound to Codex (`nativeBackend === "codex"`). Calendar runs via the Codex Calendar connector; daemon does not proxy. Obsidian, GitHub, scheduling, Skills CRUD keep direct routes.
allowed-tools:
  - Bash(curl *)
  - Read
---

# External Services — Native Mode (in-session Calendar connector)

Base URL: `http://localhost:8321`. All daemon calls via `curl -s`
with `Content-Type: application/json` on POST/PATCH/PUT.

> **Refusal directive — read first.** Google Calendar is in `native`
> mode bound to Codex. Do **NOT** call any of:
>
> - `POST /api/integrations/google_calendar/exec` (410 with
>   `X-Integration-Mode: native`)
> - `POST /api/integrations/google_calendar/reconcile` (410)
> - `/api/calendar/*` (route-prefix 410)
>
> Reach Google Calendar through the in-session Google Calendar
> connector your harness exposes. Your tool menu lists every available
> tool at session start — pick the Calendar one.
>
> Only **Google Calendar** is integration-gated here. Apple Calendar,
> Outlook Calendar, Obsidian, GitHub, recurring-schedule CRUD,
> one-shot scheduling, and Skills CRUD remain direct-mode routes.

Confirm the binding via `<integration_modes>` (`google_calendar="native"`)
and the `<integration-routing-table>` block in the session preamble.

## Source of Truth (READ FIRST)

Same as the direct-mode body — `rules/management.md` →
`## Source of Truth` and `~/.personal-agent/integrations.md` →
`## Note Sources`. If `rules/management.md` Schedule != Google
Calendar, the native binding is irrelevant; route through the
provider-specific direct route (`/api/apple-calendar/*` or
`/api/calendar/outlook/*`).

## Shell rules

`jq`, never `python3`. `curl` restricted to `http://localhost:8321`.
See the direct-mode body's "Shell rules" subsection for the full
allowlist constraints.

---

<!-- service:calendar -->
## Google Calendar — in-session connector

The exact tool names depend on which Calendar connector your harness
has loaded. Inspect your tool menu at session start and pick the
matching capability. Codex-side hosted Calendar connectors typically
expose batch read and a free-busy primitive that Claude's hosted
connector approximates with `suggest_time`; rely on the capability
classes below rather than specific names.

### Read-class capabilities

| Capability | What to do |
|---|---|
| `search` | Free-text / filter search across events. Most connectors expose two variants — a general search and a window-list flavor scoped to a `calendarId` + `timeMin` / `timeMax`. |
| `read` | Single-event read by id; many connectors also expose a "fetch full payload incl. attendees" flavor. |
| `get_availability` | Free-busy across one or more calendars (pure compute, no side effect). |
| `batch_read` | Pull many events by id in one round-trip — use when the search returned a list and you need each event's full body. |

Canonical window-list flow: invoke your connector's search-events /
list-events function with `calendar_id="primary"`, `time_min` /
`time_max` as ISO-8601 timestamps with TZ offset, and a sensible
`max_results` (≈50).

Canonical detail read (always GET-before-PATCH; see PATCH semantics
below): invoke the read-event function with `calendar_id` and the
`event_id` returned by search.

### Destructive capabilities (require explicit user confirmation)

Per the registry's
`google_calendar.backendConnectors.codex.destructiveTools`, the
following capability classes are destructive in native:codex mode:

- **Create event** — adds a new event.
- **Update event** — mutates an existing event (attendees field is
  whole-list replacement; see warning below).
- **Delete event** — removes the event.
- **Respond to event** — dispatches an RSVP to the organizer.

Apply the destructive-confirm contract: summarise the plan, wait for
explicit OK, then issue. The starter `deniedTools` list is enforced
before the call lands.

**ATTENDEES WARNING.** The update-event capability replaces the
attendees array verbatim. To add one attendee:

1. Read the event → copy `attendees`.
2. Append the new attendee.
3. Update with the full attendees list.

**Recurring events.** Single-instance edits require the instance id;
master-id PATCH shifts the whole series. Confirm scope before issuing.

### Time discipline

Same as Claude's native body — ISO 8601 with TZ offset for timed
events; `YYYY-MM-DD` for all-day. Reject naked-ISO inputs.

### Imminent-event reminders (hourly_check)

The hourly_check native variant's Step 0b drives the imminent-window
fetch each hour; this skill describes the per-call surface. POST each
materialised event to `/api/observations` per the section at the end of
this file.

<!-- /service:calendar -->

---

<!-- service:apple-calendar -->
## Apple Calendar (iCloud CalDAV) — direct, unchanged

If `rules/management.md` Schedule = Apple Calendar, use the
`/api/apple-calendar/*` routes documented in the base body. Apple
Calendar has no MCP connector; native-mode gating does not apply.
<!-- /service:apple-calendar -->

---

<!-- service:outlook-calendar -->
## Outlook Calendar (Microsoft Graph) — direct, unchanged

If `rules/management.md` Schedule = Outlook Calendar, use
`/api/calendar/outlook/*` per the direct-mode body. No Outlook
connector ships for Codex today; native-mode gating does not apply.
<!-- /service:outlook-calendar -->

---

<!-- service:obsidian -->
## Obsidian (external vault) — direct, unchanged

Same surface as the direct-mode body. Full CRUD via
`/api/obsidian/*`; requires the Obsidian app running. Omit `.md`
extensions from paths. Never use this skill to read or write the
agent's primary management vault (`today.md`, `roadmap.md`,
`projects/`, `rules/`, …) — that lives behind `/api/context/*`.

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
curl -s "http://localhost:8321/api/github/pulls?state=open"
curl -s -X POST http://localhost:8321/api/github/pulls/comment \
  -H 'Content-Type: application/json' \
  -d '{"owner": "user", "repo": "repo", "pullNumber": 42, "body": "LGTM"}'
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

The daemon computes `contentHash` server-side — pass the raw `payload`
verbatim. `actor` MUST be `"agent"` or `"system"` — the server rejects
`"user"`. HTTP 409 indicates a mode-flip race window (§11.3.1); stop
and re-read `<integration_modes>`.

---

## Scheduling — direct, unchanged

`/api/schedule`, `/api/schedule/dm`, `/api/recurring-schedules` live in
the `schedule` skill. Native-mode gating does not apply.

## Skills Management — direct, unchanged

`/api/skills` CRUD per the direct-mode body. User-authored only;
built-ins are read-only (403). Native-mode gating does not apply.

## Cost / audit

Native MCP calls land `agent_actions` rows of type `mcp_call` with
`provider="codex"`, the tool name, and the parent `event_id` /
`processKey`. The cost dashboard joins these to the registry by
`toolNamespace` prefix (§14.4 `nativeAttribution`).
