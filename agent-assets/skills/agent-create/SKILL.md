---
name: agent-create
description: Load when the user wants an ongoing task on a fixed cadence (every morning, each Monday, hourly) to run autonomously as its own named recurring Agent. Creates it via POST /api/agents. Not for one-time reminders (use schedule) or app-data background fetches (use managed-tasks).
allowed-tools:
  - Bash(curl *)
  - Read
---

# Creating a recurring Agent

A **recurring Agent** is a durable, named identity that fires on a cron cadence,
accrues its own metrics, and is managed from the dashboard `/agents` page. This
is the way to register repeating autonomous **work** — creating a recurring
`agent.task` row directly on `POST /api/recurring-schedules` is 410 Gone.

## When to use this (vs `schedule` / `managed-tasks`)

| You want… | Use |
|---|---|
| Repeating autonomous **work** on a cadence ("every morning triage my inbox and act") | **this skill** → `POST /api/agents` |
| A one-time wake-up or DM ("remind me at 3pm") | `schedule` skill → `POST /api/schedule` |
| A recurring scheduled **DM / briefing** ("DM me a summary every morning") | `schedule` skill → `POST /api/recurring-schedules` `taskType:dm_session` |
| A background fetch of app data on a cadence (managed-task fetch windows) | `managed-tasks` skill |

One-time? STOP → `schedule` skill. Just a recurring DM with no autonomous work?
Use `dm_session` (above), not an Agent.

## Before creating — dedup (mandatory)

1. `GET /api/agents` — does an enabled Agent already do this on this cadence? If
   so, do not create a duplicate. To edit one: `PATCH /api/agents/:slug` only
   toggles `enabled` (field edits return `400 user_agent_edit_via_file`); to
   change a user Agent's prompt/schedule/backend, edit its `agent.md`
   (`PATCH /api/context/policies/agents/<slug>/agent.md`) or the dashboard editor.
2. `GET /api/recurring-schedules?enabled=true` — confirm no existing recurring
   row already covers the cadence.

## Create

Prefer the **structured `recurring`** schedule — it is unambiguous and validated:

```bash
curl -s -X POST http://localhost:8321/api/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "daily-inbox-triage",
    "name": "Daily Inbox Triage",
    "description": "Triage the inbox every morning and surface anything that needs the user.",
    "schedule": {
      "kind": "recurring",
      "recurrence": { "frequency": "daily", "time": "09:00" },
      "timezone": "Asia/Tokyo"
    },
    "backend": { "tier": "medium" },
    "limits": { "max_turns": 30, "max_budget_usd": 1.0, "timeout_minutes": 15 },
    "success_criteria": [
      { "id": "triage-note", "kind": "file_exists", "target": "notes/inbox-triage-{date}.md" }
    ],
    "prompt": "<the detailed agent definition — see below>"
  }'
```

Fields:
- **`slug`** — kebab-case, must start with a lowercase letter (`^[a-z][a-z0-9-]*`),
  unique, immutable after creation (the `/agents/<slug>` URL). A leading digit or
  hyphen is rejected as `invalid_definition` on field `slug`.
- **`name`**, **`description`** — required human labels shown in the dashboard; an
  empty/omitted `description` is rejected as `invalid_definition` on field
  `description`.
- **`schedule.kind`** — `"recurring"` (structured, preferred) or `"cron"` (raw
  expression). A `one_shot`/`event` schedule is rejected with
  `one_shot_not_supported` (use `/schedule` for one-time work). Note:
  `"recurring"` is an **API-input convenience only** — the daemon converts it to a
  cron expression and persists `kind: "cron"`, so the stored `agent.md` (and the
  dashboard editor) only ever show `cron`; there is no `"recurring"` to read back.
- **`schedule.recurrence`** (when `kind:"recurring"`) — a structured recurrence:
  - `{ "frequency": "hourly", "intervalHours": 1, "minuteOfHour": 0 }` — every hour
    at :00 (`intervalHours` 1–23 for every-N-hours). **Sub-hourly is not
    supported** for user Agents.
  - `{ "frequency": "daily",  "time": "09:00" }`
  - `{ "frequency": "weekly", "time": "08:00", "daysOfWeek": [1] }` — 0=Sun…6=Sat.
  - `{ "frequency": "monthly", "time": "18:00", "daysOfMonth": [1] }`
  An invalid recurrence returns `400 invalid_recurrence` with `issues[]` — read
  them and fix the named field.
- **`schedule.expression`** (when `kind:"cron"`) — a standard 5-field cron string
  in the resolved timezone (`min hour day-of-month month day-of-week`). Examples:
  `0 9 * * *` (daily 09:00), `0 8 * * 1` (Mondays 08:00), `0 */2 * * *` (every 2h),
  `0 18 1 * *` (1st of month 18:00). Only mappable shapes actually fire: minute a
  single value; hour a single value or `*` / `*/N`. A non-mappable shape (`*/30`,
  ranges like `9-17`) is accepted at create but silently never fires — pick one
  explicit, mappable cadence.
- **`schedule.timezone`** — IANA zone; omit to inherit the daemon default.
- **`schedule.defer_in_quiet_hours`** — boolean, default `false`. When `true`, a
  firing inside the user's quiet hours is pushed to the window's end (the whole run
  moves, so data is fresh at delivery). Mechanical rule: **set `true` whenever the
  Expected output includes DMing the user**; `false` for silent overnight file work.
- **`backend`** — optional. `tier` is `lite`/`medium`/`high` (cost/capability knob;
  the standalone control that works). `process_key` defaults to `agent.task`; omit
  unless you know you need another. (Pinning an *engine* without a `model` is a
  known no-op — prefer `tier`.)
- **`limits`** — optional per-firing caps: `max_turns` (default `20`),
  `max_budget_usd` (soft cost cap, default `0.25`), `timeout_minutes` (default
  `10`). Defaults are tight; a research/briefing Agent that runs several searches
  and writes a note wants more, e.g. `{ "max_turns": 40, "max_budget_usd": 1.5,
  "timeout_minutes": 20 }`. **Set them here at create time** — omitting the block
  silently applies the defaults, and (like other user-Agent fields) limits are
  changed afterward only by editing the `agent.md`, not via `PATCH /api/agents`.
- **`playbooks`** — optional array of operating-playbook slugs to inject into the
  Agent's prompt at fire time: `research`, `markdown-note`, `monitoring`. Declaring
  one makes the daemon inject that playbook's full methodology into every run — a
  hard guarantee, and the only way the methodology reaches the Agent (there is no
  separate skill copy). **Declare every playbook you name in the prompt's
  `# Important`** — a bare mention is not injected on its own. An unknown slug is
  rejected as `invalid_definition` on field `playbooks`.
- **`success_criteria`** — optional array of deterministic post-run checks; their
  hit rate is the Agent's dashboard quality metric. **Derive 1–3 from the prompt's
  `# Output` contract** (see "Success criteria" below); omitting them when the
  prompt has an `# Output` section returns a `no_success_criteria` warning.
- **`prompt`** — the Agent's instructions (the Markdown body). **This is the most
  important field. Write it in detail.** An empty or stub body (`"placeholder"`,
  `"TODO"`, …) is rejected as `invalid_definition` on field `prompt` — the Agent
  would skip every run as ambiguous. Never create now to fill the prompt in
  later; clarify the task with the user first.

## Writing the `prompt` — the Agent has NO memory of why it exists

> A recurring Agent is spawned fresh on every firing. It receives only the
> `prompt` you write here plus the standard context (today.md, profile,
> management rules). It does NOT remember this conversation or why you created
> it. An under-specified prompt produces a vague, drifting Agent.

Author every Agent prompt with the **canonical frame** below, and resolve any
missing required slot with the user *before* you `POST /api/agents` (clarify-back).

{{> ref:prompt-frame }}

### Declare the playbooks you reference

Whenever the prompt's `# Important` names a playbook, ALSO list its slug in the
top-level `playbooks` field so the daemon injects that methodology into every
firing as a hard guarantee — not just a by-reference skill the Agent might skip:

```json
"playbooks": ["research", "markdown-note"]
```

Valid slugs: `research`, `markdown-note`, `monitoring`. If you name a playbook in
the prompt but forget to declare it, the create response returns a `warnings[]`
entry (`playbook_referenced_not_declared`) — read it and add the missing slug.

### Operational (state-mutating) Agents — extend the frame

Most Agents are content / knowledge agents (research, monitoring, note) and the
core frame above is the right shape. When the Agent instead **mutates code, files,
or system state** — the general-purpose archetype — extend the frame with scope,
a run-time autonomy boundary, and a verification receipt:

{{> ref:prompt-frame-extended }}

Reminder: if the `# Output` includes DMing the user, set
`schedule.defer_in_quiet_hours: true` (see the schedule field above).

## Success criteria — derive them from `# Output`

`success_criteria` are deterministic checks the daemon runs after every firing;
their hit rate is the Agent's dashboard quality metric (without them it has **no
quality signal**). Derive 1–3 mechanically from the `# Output` contract:

- Writes a dated note → `{ "id": "note-exists", "kind": "file_exists",
  "target": "notes/<name>-{date}.md" }`. Targets are vault-relative; `{date}`
  (the agent-day, resolved at eval time) is the only placeholder.
- Populates a note with N sections → `{ "id": "sections-filled",
  "kind": "file_section_count", "target": "…", "heading_level": 2, "min": N }` —
  counts headings of exactly `heading_level`.
- DMs the user → `{ "id": "dm-delivered", "kind": "notification_log",
  "notification_type": "agent", "delivered_within_minutes": M }` — size `M` to
  the run (30–60 typical). Caveat: matching is install-wide (ANY delivered
  `"agent"` notification in the window counts) — prefer file-based kinds when the
  output also lands in a file.
- Mutates state (no file) → `{ "id": "acted", "kind": "agent_action_count",
  "action_type": "…", "min": N }` — ≥ N logged actions of `action_type`; the
  signal for **operational Agents**.

`id` values must be unique within the Agent (duplicates are rejected as
`invalid_definition` on `success_criteria[i].id`).

## Responses & errors

Every error is `{ "error": "<code>", "hint"?: "…", "field"?: "…", "issues"?:
[{ field, message }] }`. **Read `hint` (what to do), `field` / `issues` (what to
fix), then resubmit** — almost every failure is a one-field fix the response
spells out, so retry after correcting rather than giving up.

- `201 { "status": "created", "slug": "…" }` — live; the recurring schedule is
  paired and fires on the next tick. May carry `warnings[]` (non-blocking lint:
  missing `# Instruction`, an undeclared playbook, or `# Output` with no
  `success_criteria`) — created anyway, but fix + re-save the `agent.md`.
- `400 slug_required` / `name_required` / `schedule_required` — a required field
  was missing/empty; `field` + `hint` name the one to add.
- `400 one_shot_not_supported` — schedule wasn't `cron`/`recurring`; one-time work
  goes to the `schedule` skill.
- `400 invalid_recurrence` — malformed `recurrence`; fix each `issues[]` field.
- `409 slug_collision` — that slug exists (`GET /api/agents` to inspect); pick
  another, or edit the existing Agent rather than recreating it.
- `400 invalid_definition` — schema or loader cross-check failure. Read `issues[]`
  if present, else the single `detail` string (also mirrored into `hint`). An
  empty/placeholder `prompt` lands here too — get the real task from the user,
  never retry with a stub.

Read `Read`-only files you reference in the prompt to confirm they exist before
creating the Agent.
