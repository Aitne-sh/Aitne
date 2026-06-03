---
name: external-services
description: Load when an external-services surface is in scope and Google Calendar is in native mode bound to Claude (`nativeBackend === "claude"`). Calendar runs via Claude's hosted Calendar connector; daemon does not proxy. Obsidian, GitHub, scheduling, Skills CRUD keep direct routes.
allowed-tools:
  - Bash(curl *)
  - Read
---

# External Services — Native Mode (Claude Calendar connector)

Base URL: `http://localhost:8321`. All daemon calls via `curl -s` with
`Content-Type: application/json` on POST/PATCH/PUT.

> **Refusal directive — read first.** Google Calendar is in `native`
> mode bound to Claude. Do **NOT** call any of:
>
> - `POST /api/integrations/google_calendar/exec` (returns `410` with
>   `X-Integration-Mode: native`)
> - `POST /api/integrations/google_calendar/reconcile` (410)
> - `/api/calendar/*` (route-prefix 410 in native mode)
>
> Reach Google Calendar through the in-session Google Calendar
> connector your harness exposes. Your tool menu lists every available
> tool at session start — pick the Calendar one.
>
> Only **Google Calendar** is integration-gated here. Apple Calendar,
> Outlook Calendar, Obsidian, GitHub, recurring-schedule CRUD,
> one-shot scheduling, and Skills CRUD remain direct-mode routes
> regardless of Calendar's mode.

To confirm the binding, read `<integration_modes>` (carries
`google_calendar="native"`) and the `<integration-routing-table>` block
in the session preamble.

## Source of Truth (READ FIRST)

The same two files documented in the direct-mode body are still
authoritative for non-Calendar routing:

1. **`policies/management.md` → `## Source of Truth`** — durable
   user-authored answers ("Schedule = Google Calendar", "Tasks =
   Notion", etc.).
2. **`~/.personal-agent/integrations.md` → `## Note Sources`** — the
   daemon-rendered snapshot for the user's external Obsidian vault path
   plus Notion's mode.

If `policies/management.md` Schedule = Apple Calendar or Outlook Calendar,
the user's chosen provider is **not** Google Calendar and the
native-Claude binding is irrelevant — route to `/api/apple-calendar/*`
or `/api/calendar/outlook/*` exactly as the direct-mode body documents.
The native gate covers Google Calendar only.

## Shell rules (read before writing curl pipelines)

- **JSON post-processing: use `jq`, never `python3`.** `python3` is not
  in the daemon's allowlist; the security hook denies `... | python3`
  pipelines under `permissionMode: "dontAsk"`. Use `jq` for filtering.
- **`jq` is restricted**: `--slurpfile`, `--rawfile`, `-L`, and the
  `env` filter are blocked. Use the filter language itself.
- **`curl` is restricted to `http://localhost:8321`**: connection-
  override flags (`--connect-to`, `--resolve`, `--config`, `--proxy`)
  and non-localhost hosts are blocked.

---

<!-- service:calendar -->
## Google Calendar — in-session connector

The exact tool names depend on which Calendar connector your harness
has loaded. Inspect your tool menu at session start and pick the
matching capability.

### Read-class capabilities (`requiredCapabilities` floor + optional reads)

| Capability | What to do |
|---|---|
| `list_events` | Window-list events on a calendar (`calendarId`, `timeMin`, `timeMax`, `maxResults`). |
| `get_event` | Fetch a single event by id. |
| `list_calendars` | Enumerate the user's calendars (find `primary`). |
| `suggest_time` | Free-slot proposal — pure compute, no calendar side effect. |

Canonical list flow: invoke your connector's list-events function with
`calendarId="primary"`, `timeMin` / `timeMax` as ISO-8601 timestamps with
TZ offset, and a sensible `maxResults` (≈50).

Canonical detail read (always GET-before-PATCH; see PATCH semantics
below): invoke your connector's get-event function with `calendarId` and
the `eventId` returned by list.

### Destructive capabilities (require explicit user confirmation)

Per the registry's
`google_calendar.backendConnectors.claude.destructiveTools`, the
following capability classes are destructive in native:claude mode:

- **Create event** — adds a new event.
- **Update event** — mutates an existing event (attendees field is
  whole-list replacement; see warning below).
- **Delete event** — removes the event.
- **Respond to event** — dispatches an RSVP to the organizer.

Apply the destructive-confirm contract every time. Summarise the
intended change ("create 30-min focus block at 14:00 JST tomorrow"),
wait for explicit OK, then issue the call.

**ATTENDEES WARNING.** The update-event function replaces the attendees
array verbatim — it does not append. To add one attendee:

1. Get the event → copy its `attendees: [...]`.
2. Append the new attendee object.
3. Update the event with the full attendees list.

Forgetting the GET drops every existing invitee.

**Recurring events.** Single-instance edits require the instance id
(usually returned alongside the master in list-events). PATCHing the
master id shifts the whole series. Confirm with the user which scope
they meant — "move this 9am to 10am" can mean the master or a single
occurrence and the agent must not guess.

The suggest-time capability is read-only and exempt from the confirm dance.

### Time discipline

- Timed events use ISO 8601 timestamps with a TZ offset
  (`2026-04-26T14:00:00+09:00`). Naked ISO without offset is rejected
  by the connector.
- All-day events use `YYYY-MM-DD` with no offset.
- Be explicit which shape the destructive-confirm plan describes.

### Imminent-event reminders (hourly_check)

Native mode replaces the daemon-side
`POST /api/integrations/google_calendar/reconcile` POST that delegated
mode uses. In native mode, the agent itself drives the imminent-window
fetch every hour and POSTs each materialised event to
`/api/observations`. The hourly_check native variant's Step 0b spells
out the exact shape; this skill describes the call surface.

Free-busy queries are composed locally — the suggest-time capability
returns slot proposals against a primary calendar; for explicit
free-busy across multiple calendars, list each calendar's events in
the window and intersect.

<!-- /service:calendar -->

---

<!-- service:apple-calendar -->
## Apple Calendar (iCloud CalDAV) — direct, unchanged

If `policies/management.md` Schedule = Apple Calendar, use the
`/api/apple-calendar/*` routes documented in the base body. Apple
Calendar has no MCP connector; native-mode gating does not apply.

The direct-mode body's full apple-calendar reference (status probe,
list/get/create/update/delete, recurring-event semantics, error
envelope) is the source of truth — copy that section's shape
verbatim. The note here exists only to remind the agent that the
native binding above is Google-only.
<!-- /service:apple-calendar -->

---

<!-- service:outlook-calendar -->
## Outlook Calendar (Microsoft Graph) — direct, unchanged

If `policies/management.md` Schedule = Outlook Calendar, use
`/api/calendar/outlook/*` per the direct-mode body. Microsoft does not
ship a hosted Outlook Calendar connector for Claude / Codex / Gemini
today; native-mode gating does not apply.
<!-- /service:outlook-calendar -->

---

<!-- service:obsidian -->
## Obsidian (external vault) — direct, unchanged

**Scope**: this skill targets the **separate** Obsidian vault the user
maintains alongside this app — never the agent's primary management
store (`state/today.md`, `plans/roadmap.md`, `projects/`, `rules/`, `routines/`,
`user/`, `agent/`). Those are reached via `/api/context/*` (see the
`context` skill).

Full CRUD over the external vault. Requires the Obsidian app running
(the CLI proxies through it). Omit the `.md` extension from paths.
All writes are Autonomous; the daemon does not DM the owner before /
after the call.

```bash
curl -s http://localhost:8321/api/obsidian/status                            # external vault availability
curl -s "http://localhost:8321/api/obsidian/search?q=meeting+notes&limit=10" # search external vault
curl -s http://localhost:8321/api/obsidian/notes/Daily%20Notes/2026-04-06    # read external note
curl -s -X POST http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"name": "Meeting Notes 2026-04-02", "content": "# Meeting\n..."}'    # create (fails if exists)
curl -s -X PUT http://localhost:8321/api/obsidian/notes/Projects/ProjectA \
  -H 'Content-Type: application/json' -d '{"content": "# Full body"}'       # create-or-overwrite
curl -s -X PATCH http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"file": "Meeting Notes 2026-04-02", "content": "\n- Action item"}'   # append
curl -s -X PATCH http://localhost:8321/api/obsidian/daily \
  -H 'Content-Type: application/json' -d '{"content": "- [ ] Follow up"}'   # append to external daily
curl -s -X DELETE http://localhost:8321/api/obsidian/notes/Projects/Old      # delete (moves to trash)
```

**Endpoint choice**: Read → GET, Create-only → POST, Edit → PUT,
Append → PATCH.
<!-- /service:obsidian -->

---

<!-- service:github -->
## GitHub — direct, unchanged

```bash
curl -s http://localhost:8321/api/github/repos                                    # list watched repos
curl -s "http://localhost:8321/api/github/pulls?owner=user&repo=repo&state=open"  # list PRs
curl -s -X POST http://localhost:8321/api/github/pulls/comment \
  -H 'Content-Type: application/json' \
  -d '{"owner": "user", "repo": "repo", "pull_number": 42, "comment": "LGTM"}'    # comment — Autonomous
```
<!-- /service:github -->

---

<!-- service:notion -->
## Notion

Notion operations live in the dedicated `notion` skill — load that
when the user asks anything Notion-shaped (search, query, read,
create, update, archive). Notion's own native binding is independent
of Calendar's; the `notion` skill picks the right variant from the
session's integration state.
<!-- /service:notion -->

---

## Persisting Calendar observations from native fetches

When the hourly_check native flow's Step 0b fetches imminent-window
events, POST each materialised event to `/api/observations` so
subsequent runs can dedup. The daemon computes `contentHash`
server-side via `@aitne/shared/observations-hash` — pass
the raw `payload`.

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

`actor` MUST be `"agent"` or `"system"` — the server rejects `"user"`.

`/api/observations` is never gated. HTTP 409 indicates a mode-flip race
window (§11.3.1) — stop and re-read `<integration_modes>`.

The two-fetch pattern (imminent 15-min + 24-hour drift detection)
documented in `routine.hourly_check.native.claude.md` is the canonical
shape; this skill describes the per-call surface, not the orchestration.

---

## Scheduling — direct, unchanged

One-shot wake-ups, pre-composed DMs, and recurring agent tasks live in
the `schedule` skill — `/api/schedule`, `/api/schedule/dm`,
`/api/recurring-schedules`. Native-mode gating does not apply to the
schedule surface (scheduling is daemon-internal, not an integration).

---

## Skills Management — direct, unchanged

User-authored skills: `<contextDir>/policies/skills/{slug}/SKILL.md`.
Built-in skills are read-only (403). Native-mode gating does not apply.

```bash
curl -s http://localhost:8321/api/skills                                            # list all
curl -s http://localhost:8321/api/skills/todo-digest                                # read one
curl -s -X POST http://localhost:8321/api/skills \
  -H 'Content-Type: application/json' \
  -d '{"name": "todo-digest", "description": "Summarize today.md", "content": "# TODO Digest\n...", "allowedTools": ["Bash(curl *)", "Read"]}'
curl -s -X PUT http://localhost:8321/api/skills/todo-digest \
  -H 'Content-Type: application/json' -d '{"description": "New description"}'      # update
curl -s -X DELETE http://localhost:8321/api/skills/todo-digest                      # delete
```

Always `GET /api/skills` before creating (check name collisions).
**Omit frontmatter** from `content` — the API injects it.

## Cost / audit

Native Calendar MCP calls land `agent_actions` rows of type
`mcp_call` with `provider="claude"`, the tool name, and the parent
`event_id` / `processKey`. The cost dashboard joins these to the
registry by `toolNamespace` prefix for the `nativeAttribution` rollup
(§14.4).
