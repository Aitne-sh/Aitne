---
schema_version: 1
slug: features/routines/custom-routines
title: Custom Routines
id: custom-routines
aliases:
  - custom routine
  - cron routine
  - user routine
category: features
summary: |
  Beyond the built-in morning / evening / weekly / hourly routines,
  the operator can define custom routines that fire on any cron
  schedule. Each routine is a Markdown file under
  policies/routines/custom/, runs under the tier the operator picks,
  and is bounded by the same safety layers as the built-ins.
section: routines
tags:
  - routines
  - autonomous
  - scheduler
  - core
  - advanced
status: stable
ask_examples:
  - How do I add a custom routine?
  - What can a custom routine do?
  - Can I disable a custom routine?
  - Which tier does a custom routine run under?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - custom routine
  - routine.custom.<slug>
  - user-defined routine
  - scheduled task
  - recurring schedule
  - cron routine
related:
  - guides/add-a-custom-routine
  - concepts/routines
  - features/memory-files/schedule
prerequisites:
  - concepts/routines
process_keys:
  - routine.custom.<slug>
context_files:
  - policies/routines/custom/<slug>.md
api_endpoints:
  - PUT /api/context/*
  - POST /api/recurring-schedules
ui_anchors:
  - /settings/routines
  - /connections/routines
---

# Custom Routines

## In One Sentence

Operator-defined routines fire on any cron schedule, run under the
tier the operator picks (`lite` / `medium` / `high`), and are bounded
by the same safety layers as the built-ins.

## What It Does

- Runs a vault-file-defined check list on a cron schedule.
- Resolves the backend at fire time from the chosen tier (no concrete
  model picker — tier resolution mirrors the built-in routines).
- Logs its run to Activity exactly like a built-in routine.

## When It Runs

The cron expression in the routine's vault file
`policies/routines/custom/<slug>.md` drives the cadence. The scheduler
wires one `node-cron` job per enabled routine at startup and fires a
`routine.custom.<slug>` event on each tick.

It is a **standard 5-field cron expression** (`min hour day-of-month
month day-of-week`); for example `0 11 * * 2` is every Tuesday at
11:00 local time, in your configured timezone.

## How Changes Are Picked Up

There is **no filesystem watcher**. The scheduler reloads only when a
write goes through the context API — a `PUT` / `PATCH` / `DELETE`
under `policies/routines/custom/` triggers an automatic re-diff of the
registered jobs against what is on disk, so edits made through the
dashboard, the API, or the agent take effect without a daemon restart.

A raw file edit that bypasses the API (for example, opening the `.md`
in an external editor) is *not* picked up until the next API write to
that directory or a daemon restart. Prefer editing through **Settings
→ Routines** or the context API.

## What It Outputs

- Whatever the check list produces — a context-file write, a
  notification, or a no-op.

## Where in the Dashboard

- **Settings → Routines** (`/settings/routines`) is the operator
  surface for adding, editing, and disabling. `/connections/routines`
  is an equivalent page that opens the same surface.

## Configuration

Each custom routine is a Markdown file under
`~/.personal-agent/context/policies/routines/custom/<slug>.md` whose
frontmatter carries:

| Field | Type | Notes |
|---|---|---|
| `type` | `rule` | Always `rule` for custom routines. |
| `slug` | string | Kebab-case; matches the file stem and the ProcessKey suffix. |
| `cron` | string | Standard 5-field cron expression (e.g. `0 11 * * 2`). |
| `process_key` | `routine.custom.<slug>` | Must match the slug. |
| `enabled` | boolean (`true` / `false`) | Disable without deleting by setting `false`. |
| `backend_tier` | `lite` \| `medium` \| `high` | Drives BackendRouter tier resolution. Legacy `light` (→ `medium`) and `heavy` (→ `high`) are still accepted for files written before the rename. |
| `max_budget_usd` | number | Per-execute USD cap; must be a positive number (e.g. `0.05`). |

Every field above is required; the body must contain a `## Checks`
section — a routine that is missing any of them is rejected at write
time with a validation error.

The `## Checks` section is the list the agent runs through on each
fire. To change a routine, write through the context API (the
dashboard, the API, or the agent), which triggers an automatic reload
as described above — no daemon restart is needed.

### Example

A `tuesday-standup-prep` routine at
`policies/routines/custom/tuesday-standup-prep.md`:

```markdown
---
type: rule
slug: tuesday-standup-prep
cron: "0 11 * * 2"
process_key: routine.custom.tuesday-standup-prep
enabled: true
backend_tier: medium
max_budget_usd: 0.10
---

## Checks

- Summarize commits I pushed since last Tuesday.
- List any calendar events for the rest of the week that mention
  "standup" or "review".
- If there is anything noteworthy, DM me a short prep note.
```

This fires every Tuesday at 11:00 (your configured timezone), runs
under the `medium` tier (Sonnet on the Claude backend), and stops
spending once the run reaches $0.10.

> **Distinct from `recurring_schedules`.** The `recurring_schedules`
> table now powers recurring scheduled DMs only (`task_type =
> 'dm_session'`) — e.g. the morning briefing. They use a structured
> `RecurrenceRule` (frequency + time + dayOf*) and are managed via
> `POST /api/recurring-schedules`. Recurring agent *work* moved to the
> `/agents` layer — `POST /api/recurring-schedules` with any
> non-`dm_session` task type returns 410 Gone with a pointer to
> `POST /api/agents`. Neither is the same surface as
> `routine.custom.<slug>`.

## When Something Goes Wrong

- A cron expression that resolves to "never": the routine appears in
  the list but never fires. The dashboard's "Next runs" preview shows
  "No upcoming runs found within the next year for this timezone."

## Related

- [Add a Custom Routine](../../guides/add-a-custom-routine.md)
