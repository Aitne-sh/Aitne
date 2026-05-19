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
  schedule.
section: routines
tags:
  - routines
  - autonomous
  - advanced
status: stable
ask_examples:
  - How do I add a custom routine?
  - What can a custom routine do?
  - Can I disable a custom routine?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - custom routine
  - routine.custom.<slug>
  - user-defined routine
  - scheduled task
  - recurring schedule
related:
  - guides/add-a-custom-routine
  - concepts/routines
process_keys:
  - routine.custom.<slug>
---

# Custom Routines

## In One Sentence

Operator-defined routines fire at any cron schedule, run under the
backend the operator picks (light / heavy tier), and are bounded by
the same safety layers as the built-ins.

## What It Does

- Runs a vault-file-defined check list at a cron schedule.
- Resolves the backend at fire time from the chosen tier (no concrete
  model picker — tier resolution mirrors the built-in routines).
- Logs its run to Activity exactly like a built-in routine.

## When It Runs / How It Is Triggered

The cron expression in the routine's vault file
`routines/custom/<slug>.md`. The custom-routine scheduler watches the
file and re-reads the frontmatter on every change.

## What It Outputs

- Whatever the check list produces — a context-file write, a
  notification, a no-op.

## Where in the Dashboard

- **Settings → Routines** is the operator surface for adding,
  editing, and disabling. (The `/connections/routines` URL is a
  back-compat alias that redirects here.)

## Configuration

Each custom routine is a Markdown file under
`~/.personal-agent/context/routines/custom/<slug>.md` whose
frontmatter carries:

| Field | Type | Notes |
|---|---|---|
| `type` | `rule` | Always `rule` for custom routines. |
| `slug` | string | Kebab-case; matches the file stem and the ProcessKey suffix. |
| `cron` | string | Standard 5-field cron expression (e.g. `0 11 * * 2`). |
| `process_key` | `routine.custom.<slug>` | Must match the slug. |
| `enabled` | boolean | Disable without deleting by setting `false`. |
| `backend_tier` | `light` \| `heavy` | Drives BackendRouter tier resolution. |
| `max_budget_usd` | number | Per-execute USD cap (e.g. `0.05`). |

The body holds the `## Checks` section the agent runs through on each
fire. Hand-editing the file is fully supported — the watcher picks up
changes without a daemon restart.

> **Distinct from `recurring_schedules`.** The `recurring_schedules`
> table powers DM-style scheduled tasks (`agent.task` /
> `agent.dm_task`) — e.g. "remind me at 9am every weekday". Those
> use a structured `RecurrenceRule` (frequency + time + dayOf*) and
> are managed via `POST /api/recurring-schedules`. They are not the
> same surface as `routine.custom.<slug>`.

## When Something Goes Wrong

- A cron expression that resolves to "never": the routine appears in
  the list but never fires. The dashboard shows next-fire as N/A.

## Related

- [Add a Custom Routine](../../guides/add-a-custom-routine.md)
