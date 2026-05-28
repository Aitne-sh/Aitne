---
name: external-services
description: Load when the task touches Google Calendar, Obsidian, GitHub, or Skills CRUD AND Google Calendar is cross-backend delegated from a Claude DM session. Calendar calls route through `POST /api/integrations/google_calendar/exec`; other surfaces keep their direct routes.
allowed-tools:
  - Bash(curl *)
  - Read
---

# External Services API Reference — Cross-Backend Delegated (Claude DM)

Base URL: `http://localhost:8321`. All calls via `curl -s` with
`Content-Type: application/json` on POST/PATCH/PUT.

Your DM session runs on Claude Code. **Google Calendar** access has been
delegated to a different backend whose Calendar connector is signed in.
You describe Calendar intent in natural language; the daemon spawns the
delegated backend, lets it pick the right MCP tool, and returns a
schema-validated JSON result. The hosted Google Calendar connector
tools are not on this session's tool menu (Calendar is not delegated to
Claude in this session).

The rest of this skill — Obsidian, GitHub, recurring schedules, one-shot
scheduling, skills CRUD — works identically to the direct-mode body.
Refer to that body for those services; **only the Calendar section below changes** under cross-backend delegation.

To check which backend currently owns the Calendar connector, read
`~/.personal-agent/integrations.md`. The `/exec` body below is
backend-agnostic — Codex, Gemini, and any custom MCP server the user
installs are all addressed the same way.

## Shell rules (read before writing curl pipelines)

- **JSON post-processing: use `jq`, never `python3`.** `python3` is not
  in the daemon's allowlist, so `curl ... | python3 -c ...` is denied
  under `permissionMode: "dontAsk"` and the call silently fails. Use
  `jq` for all field extraction, filtering, and pretty-printing.
- **`jq` is restricted**: `--slurpfile`, `--rawfile`, `-L`, and the
  `env` filter are blocked by the security hook. Use only the filter
  language itself.
- **`curl` is restricted to `http://localhost:8321`**: connection-
  override flags and non-localhost hosts are blocked.

---

<!-- service:calendar -->
## Calendar (delegated, cross-backend)

Every Calendar operation is one POST to the daemon's task-mode endpoint:

```bash
curl -s -X POST http://localhost:8321/api/integrations/google_calendar/exec \
  -H 'Content-Type: application/json' \
  -d '{"task": "<natural-language intent>", "outputSchema": { ... }, "cacheable": true}'
```

The daemon:

1. Verifies Calendar is in `mode="delegated"`. If not, you get
   `409 mode_mismatch` — re-read `integrations.md` and stop.
2. Verifies your DM backend isn't the same as `delegatedBackend`. If it
   is, you get `409 mode_mismatch` and should switch to native MCP
   (you'd have those tools without this skill).
3. Spawns the delegatedBackend, lets it pick the right tool against the
   per-task allowed-tools envelope, validates the final JSON against
   your `outputSchema`, returns it.

You **describe Calendar intent in natural language**. Tool name
divergence between Codex (`search_events`, `create_event`), Gemini
(`listEvents`, `createEvent`) and any custom MCP server the user
installs is invisible to you.

### Worked examples

#### List events in a window (read)

```bash
curl -s -X POST http://localhost:8321/api/integrations/google_calendar/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "List every confirmed event on my primary calendar between 2026-04-29T00:00:00+09:00 and 2026-05-30T00:00:00+09:00. Sort by start time ascending.",
    "outputSchema": {
      "type": "object",
      "required": ["events"],
      "properties": {
        "events": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id", "title", "start", "end"],
            "properties": {
              "id":    {"type": "string"},
              "title": {"type": "string"},
              "start": {"type": "string", "format": "date-time"},
              "end":   {"type": "string", "format": "date-time"},
              "attendees": {"type": "array", "items": {"type": "string"}}
            }
          }
        }
      }
    },
    "cacheable": true
  }'
```

#### Find free time + create an event (multi-step composition)

```bash
curl -s -X POST http://localhost:8321/api/integrations/google_calendar/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Find a 30-minute free slot on my primary calendar tomorrow afternoon (13:00-17:00 local). Create a Calendar event titled \"Focus block\" in that slot with description \"Heads-down on the migration plan\".",
    "outputSchema": {
      "type": "object",
      "required": ["eventId", "start", "end"],
      "properties": {
        "eventId": {"type": "string"},
        "start":   {"type": "string", "format": "date-time"},
        "end":     {"type": "string", "format": "date-time"}
      }
    },
    "maxToolCalls": 5,
    "allowDestructive": true
  }'
```

(Create / update / delete are destructive — pass
`allowDestructive: true` after the user has confirmed the
`needsConfirmation` plan, or skip the dance for self-only events you
already greenlit.)

`outputSchema` is **required** (4 KB cap). Defaults: `maxToolCalls=7`,
`maxBudgetUsd=0.05`, `timeoutMs=60000`. Bump up to 15 / 0.50 / 300000
for genuinely larger intents.

### Destructive-confirm two-step (`allowDestructive`)

Default is `false`. The subprocess will not run create / update /
delete / respond — it returns:

```jsonc
{
  "needsConfirmation": true,
  "confirmationPlan": "I will create a 30-min event titled \"Focus block\" tomorrow at 14:00 JST."
}
```

Surface the plan to the user verbatim. On explicit OK, re-issue the
**same `task` verbatim** with `allowDestructive: true`. Do NOT set
`cacheable: true` on the second call.

### `cacheable: true` for read-only Calendar lookups

Calendar list / search responses are good cache candidates because the
agent often follows up immediately with a related read. The 60s TTL
keeps stale-vs-fresh tension acceptable for week-scale and month-scale
queries. **Skip caching** for "today's events" if minute-level
freshness matters, and never on a destructive-confirm second call.

### Decision rules

- **Update / delete + send invite are destructive.** The
  `needsConfirmation` envelope is the standard interaction; surface
  the plan and ask before pressing OK.
- **All-day vs timed**: timed events need ISO 8601 timestamps with TZ
  offset (e.g. `2026-04-02T14:00:00-04:00`). All-day events use
  `YYYY-MM-DD` with no offset. Be explicit in the `task` body which
  shape you intend.
- **Attendees on update**: treat the `attendees` field as
  authoritative on the next write — describe the full final list in
  your `task`, not a delta.
- **Free/busy** under cross-backend: phrase the intent as
  "find a free slot…" — the subprocess picks the right primitive
  (`findFreeTime` / `get_availability` / window-list inspection)
  whichever connector is active.
- When you do mutate the calendar in a way the user would want to
  know about, call `POST /api/notify` with a one-line summary. The
  daemon does NOT auto-notify — it's an explicit choice.

### Error envelope

`/exec` extends the direct-mode envelope with delegated-mode fields.
Discriminator: `body.mode === "delegated"`.

| HTTP | `error` | retry? | What to do |
|---|---|---|---|
| 400 | `validation_error` / `schema_too_large` | no | Fix the request body. |
| 409 | `mode_mismatch` | no | Calendar isn't delegated, OR your DM backend matches `delegatedBackend`. Re-read `integrations.md` and stop. |
| 409 | `precondition` | no | Mode/backend flipped during the queue wait. Re-check state and re-plan. |
| 429 | `task_quota_exhausted` | no | Daily cap reached; wait or surface. |
| 502 | `parse_error` / `schema_violation` | no (daemon already retried once) | Consider a simpler schema. |
| 502 | `tool_unavailable` | no | No connector tool fits the intent. Surface the gap. |
| 502 | `tool_failed` | maybe | Connector tool returned an error. Surface `body.message` verbatim; retry only if clearly transient. |
| 502 | `auth_error` | no | Connector signed out. Tell the user to re-authenticate it. |
| 502 | `policy_violation` | no | Subprocess attempted a tool outside the per-task allowlist (anti-injection). |
| 502 | `loop_aborted` | no | `maxToolCalls` exceeded. Bump the cap or simplify. |
| 502 | `budget_exhausted` | no | `maxBudgetUsd` exceeded. Caller can raise the cap. |
| 502 | `post_write_format_failure` | no | Write succeeded; formatting failed. Side effect is real — surface with the partial trace. |
| 503 | `delegated_proxy_busy` | yes | Daemon queue saturated. Backoff a few seconds, try once. |
| 503 | `task_mode_disabled` | no | Operator turned the kill switch off. Stop. |
| 504 | `timeout` | yes (1×) | Wall-clock fired. Retry once if intent was simple. |
| 500 | `subprocess_crashed` | no | Unhandled exception inside the subprocess. Surface and stop. |

Always preserve `body.message` verbatim when reporting to the user — it
carries the connector's own language.
<!-- /service:calendar -->

---

<!-- service:obsidian -->
## Obsidian (external vault)

**Scope**: this skill targets a **separate** Obsidian vault the user
maintains alongside this app — e.g. a personal knowledge base. It is
**not** the agent's own primary management store. The agent's primary
files (`state/today.md`, `plans/roadmap.md`, `projects/`, `rules/`, `routines/`,
`user/`, `agent/`, …) live in the primary vault and are reached via
`/api/context/*` (see the `context` skill). **Never** use this skill to
read or write the primary vault.

Use this skill when the user asks the agent to look up, append to, or
create notes inside their external knowledge vault — never for the
agent's own working state.

Full CRUD over the external vault. Requires the Obsidian app running
(the CLI proxies through it). Omit `.md` extension from paths. All
writes are Autonomous; the daemon does not DM the owner before/after
the call. Call `POST /api/notify` yourself when the user would want to
know.

```bash
curl -s http://localhost:8321/api/obsidian/status                            # external vault availability
curl -s "http://localhost:8321/api/obsidian/search?q=meeting+notes&limit=10" # search external vault
curl -s http://localhost:8321/api/obsidian/notes/Daily%20Notes/2026-04-06    # read external note
curl -s -X POST http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"name": "Meeting Notes 2026-04-02", "content": "# Meeting\n..."}'    # create external note (fails if exists)
curl -s -X PUT http://localhost:8321/api/obsidian/notes/Projects/ProjectA \
  -H 'Content-Type: application/json' -d '{"content": "# Full body"}'       # create-or-overwrite external note
curl -s -X PATCH http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"file": "Meeting Notes 2026-04-02", "content": "\n- Action item"}'   # append to external note
curl -s -X PATCH http://localhost:8321/api/obsidian/daily \
  -H 'Content-Type: application/json' -d '{"content": "- [ ] Follow up"}'   # append to external daily note
curl -s -X DELETE http://localhost:8321/api/obsidian/notes/Projects/Old      # delete from external vault (moves to trash)
```
**Endpoint choice**: Read → GET, Create-only → POST, Edit → PUT, Append → PATCH.

If the user's request is really about the agent's own state (today, roadmap,
projects, journal, rules, routines, user profile), switch to the `context`
skill and the `/api/context/*` endpoints instead.
<!-- /service:obsidian -->

---

<!-- service:github -->
## GitHub

```bash
curl -s http://localhost:8321/api/github/repos                              # list watched repos
curl -s "http://localhost:8321/api/github/pulls?state=open"                  # list PRs
curl -s -X POST http://localhost:8321/api/github/pulls/comment \
  -H 'Content-Type: application/json' \
  -d '{"owner": "user", "repo": "repo", "pullNumber": 42, "body": "LGTM"}' # comment — Autonomous
```
<!-- /service:github -->

---

<!-- service:notion -->
## Notion

Notion operations live in the dedicated `notion` skill — load that when
the user asks anything Notion-shaped (search, query, read, create,
update, archive).
<!-- /service:notion -->

---

## Recurring Schedules

CRUD for repeating agent tasks. Timezone auto-filled from daemon config.

```bash
curl -s -X POST http://localhost:8321/api/recurring-schedules \
  -H 'Content-Type: application/json' \
  -d '{"taskType": "wake", "description": "Morning inbox triage.", "recurrenceRule": {"frequency": "daily", "time": "09:00"}}'
curl -s "http://localhost:8321/api/recurring-schedules?enabled=true"         # list
curl -s -X PATCH http://localhost:8321/api/recurring-schedules/1 \
  -H 'Content-Type: application/json' \
  -d '{"recurrenceRule": {"frequency": "weekly", "time": "10:00", "daysOfWeek": [1,3,5]}}'
curl -s -X PATCH http://localhost:8321/api/recurring-schedules/1 \
  -H 'Content-Type: application/json' -d '{"enabled": false}'              # disable
curl -s -X DELETE http://localhost:8321/api/recurring-schedules/1           # delete
```
`recurrenceRule`: `frequency` (daily/weekly/monthly), `time` (HH:MM), `daysOfWeek` (0=Sun..6=Sat, weekly), `daysOfMonth` (1-31, monthly). → Full guide: load `schedule` skill.

---

## One-Shot Scheduling

Schedule a future DM or agent task. Use `<current_time>` to resolve relative times into absolute ISO 8601 with offset.

### DM vs Agent Task

| Criterion | `/api/schedule/dm` (free) | `/api/schedule` (~$0.03) |
|---|---|---|
| Message text knowable now? | Yes | No — needs lookup/decision at execution |
| Needs API data at execution? | No | Yes |
| Multi-step action? | No | Yes |
| Conditional on state that may change? | No | Yes |

**Default to DM** — every agent wake-up costs money and context.

### Context-loss warning

> The wake-up agent has NO memory of why it was scheduled — the `description` field is its only context.

Include: **What** (verb + object), **Why** (trigger/reason), **Who/What** (names, IDs, URLs), **Expected output** (what success looks like).

Bad: `"Meeting prep"` — which meeting? when? what to prepare? The wake-up agent will skip ambiguous descriptions.

### POST /api/schedule/dm — Pre-composed DM
```bash
curl -s -X POST http://localhost:8321/api/schedule/dm \
  -H 'Content-Type: application/json' \
  -d '{"time": "2026-04-06T16:00:00-04:00", "message": "Reminder: Design review in 30 min.", "platform": "slack"}'
```

### POST /api/schedule — Agent task
```bash
curl -s -X POST http://localhost:8321/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"time": "2026-04-06T16:00:00-04:00", "taskType": "wake", "description": "Check PR #42 status and notify user.", "tier": "medium", "taskContext": {"scheduledBy": "dm_conversation"}}'
```
Fields: `time` (required), `taskType` (`wake`), `description` (required, min 20 chars), `tier` (`lite`/`medium`/`high`) **or** `model` (registered id like `claude-opus-4-8`, legacy alias `sonnet`/`opus`, or composite `<backendId>/<modelId>`) — mutually exclusive, `taskContext` (optional metadata). See the `schedule` skill body for the full surface and `/api/schedule/options` for the live model list.

### Manage pending items
```bash
curl -s "http://localhost:8321/api/schedule?status=pending"                         # list
curl -s -X PATCH http://localhost:8321/api/schedule/42 \
  -H 'Content-Type: application/json' -d '{"time": "2026-04-06T17:00:00-04:00"}'   # edit
curl -s -X DELETE http://localhost:8321/api/schedule/42                              # cancel
```
Editable: `time`, `description`, `message` (dm only), `tier` (or `model`, mutually exclusive — pass `null` to clear), `taskContext`. Only `pending` items.

### Time discipline
- Absolute ISO 8601 with offset required — no relative times.
- Do not schedule during quiet hours (default 22:00–08:00, configurable) unless critical.
- Maximum 5 wake-ups per execution.

---

## Skills Management

User-authored skills: `~/.personal-agent/skills/{slug}/SKILL.md`. Built-in skills are read-only (403). Slug: lowercase kebab-case `[a-z0-9][a-z0-9-]*`, 1–64 chars.

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
Always `GET /api/skills` before creating (check name collisions). **Omit frontmatter** from `content` — the API injects it.
