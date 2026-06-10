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

If the request is one-time, STOP and use the `schedule` skill. If it just sends a
recurring DM with no autonomous work, use `dm_session` (above), not an Agent.

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
  `"recurring"` is an **API-input convenience only** — the daemon converts the
  `recurrence` object to a cron expression and persists it as `kind: "cron"`.
  The Agent's on-disk `agent.md` frontmatter (and the dashboard editor) therefore
  only ever show `schedule.kind ∈ { cron, one_shot, event }`; there is no stored
  `"recurring"` kind to read back or PATCH.
- **`schedule.recurrence`** (when `kind:"recurring"`) — a structured recurrence:
  - `{ "frequency": "hourly", "intervalHours": 1, "minuteOfHour": 0 }` — every hour
    at :00 (`intervalHours` 1–23 for every-N-hours). **Sub-hourly (e.g. every
    30 min) is not supported** for user Agents.
  - `{ "frequency": "daily",  "time": "09:00" }`
  - `{ "frequency": "weekly", "time": "08:00", "daysOfWeek": [1] }` — 0=Sun…6=Sat.
  - `{ "frequency": "monthly", "time": "18:00", "daysOfMonth": [1] }`
  An invalid recurrence returns `400 invalid_recurrence` with `issues[]` — read
  them and fix the named field.
- **`schedule.expression`** (when `kind:"cron"`) — a standard 5-field cron string
  in the resolved timezone (`min hour day-of-month month day-of-week`). Examples:
  `0 9 * * *` (daily 09:00), `0 8 * * 1` (Mondays 08:00), `0 * * * *` (hourly at
  :00), `0 */2 * * *` (every 2 hours), `0 18 1 * *` (1st of each month 18:00).
  A syntactically-valid cron is accepted at create (`201`, valid row) even if it
  cannot be mapped to a recurrence — but a non-mappable shape (sub-hourly steps
  like `*/30`, hour ranges/lists like `9-17`) is never paired and silently never
  fires. Only shapes that map are actually run: minute a single value; hour a
  single value or `*` / `*/N`. Pick one explicit, mappable cadence.
- **`schedule.timezone`** — IANA zone; omit to inherit the daemon default.
- **`schedule.defer_in_quiet_hours`** — boolean, default `false`. When `true`, a
  firing that lands inside the user's quiet hours is pushed to the window's end
  instead of running — the whole run moves, so the data is fresh at delivery
  time. Mechanical rule: **set `true` whenever the Expected output includes
  DMing the user**; leave it `false` for silent file-writing work deliberately
  scheduled overnight.
- **`backend`** — optional. `tier` is `lite`/`medium`/`high` (cost/capability knob;
  the standalone control that works). `process_key` defaults to `agent.task`;
  omit unless you know you need another. (Pinning a backend *engine* without a
  `model` is a known no-op — prefer `tier`.)
- **`prompt`** — the Agent's instructions (the Markdown body). **This is the most
  important field. Write it in detail.**

## Writing the `prompt` — the Agent has NO memory of why it exists

> A recurring Agent is spawned fresh on every firing. It receives only the
> `prompt` you write here plus the standard context (today.md, profile,
> management rules). It does NOT remember this conversation or why you created
> it. An under-specified prompt produces a vague, drifting Agent.

Write the prompt as a self-contained brief covering all four:

| Element | What it must answer |
|---|---|
| **Requirements / preconditions** | What must be true / what inputs to read first (files, APIs, accounts). What to do if a precondition is missing. |
| **Goal** | The single outcome this Agent exists to produce, stated concretely. |
| **Process** | The ordered steps to run each firing — specific verbs, endpoints, filenames, decision rules. |
| **Expected output** | What "done" looks like: which file/section is written, whether/when to DM the user, what NOT to do. |

**Good prompt (excerpt):**
```
## Goal
Each morning, surface inbox items that need the user's decision today.

## Requirements
- Read state/today.md for the day's agenda before triaging.
- Mail access via the mail skill endpoints; if mail is unreachable, log the gap
  to the Agent Log and exit without DMing.

## Process
1. GET unread mail from the last 24h.
2. Classify: actionable-today / FYI / ignore (rules: …).
3. Append a "## Inbox triage" section to state/today.md with the actionable set.
4. DM the user ONLY if ≥1 item is time-sensitive today.

## Output
- today.md updated with the triage section.
- At most one DM, sent only for time-sensitive items.
```

**Bad prompt:** `"Triage my inbox."` — no requirements, no steps, no output
contract; the Agent will improvise differently every day.

The Expected-output decision feeds one schedule field: if the output contract
includes DMing the user, also set `schedule.defer_in_quiet_hours: true` so a
firing inside quiet hours waits for the window's end instead of producing a
message that would be held anyway.

## Responses & errors

- `201 { "status": "created", "slug": "…" }` — the Agent is live; its recurring
  schedule is paired and it will fire on the next matching tick.
- `400 one_shot_not_supported` — the schedule was not `cron`/`recurring`. Use the
  `schedule` skill for one-time tasks.
- `400 invalid_recurrence` — a `kind:"recurring"` schedule carried a malformed
  `recurrence`. Read `issues[]` (each `{ field, message }`), fix the named field,
  and resubmit.
- `409 slug_collision` — pick a different slug.
- `400 invalid_definition` — the assembled definition failed validation. Two
  shapes share this error: pre-write schema validation returns `hint` +
  `issues[]` (each `{ field, message }`); the post-write cross-check (loader
  rejects the freshly written file) returns `slug` + a single `detail` string
  (or `null`). Read `issues[]` if present, else fall back to `detail`, fix the
  reported field(s), and resubmit.

Read `Read`-only files you reference in the prompt to confirm they exist before
creating the Agent.
