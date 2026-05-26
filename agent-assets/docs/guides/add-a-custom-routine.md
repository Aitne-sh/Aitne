---
schema_version: 1
slug: guides/add-a-custom-routine
title: Add a Custom Routine
id: add-a-custom-routine
aliases:
  - custom routine
  - user-defined routine
  - add a routine
  - scheduled task
category: guides
summary: |
  Define a new autonomous routine — slug, cron expression, tier, and
  budget cap — via /settings/routines. The form writes a vault file at
  routines/custom/<slug>.md.
section: add-a-custom-routine
tags:
  - guide
  - routines
  - scheduler
status: stable
ask_examples:
  - How do I add a custom routine?
  - What can a custom routine do?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - custom routine
  - schedule
  - cron
  - recurrence
  - PUT /api/recurring-schedules
related:
  - features/routines/custom-routines
  - concepts/routines
---

# Add a Custom Routine

## Goal

Make the agent fire a particular kind of work on a schedule you pick.

## Prerequisites

- Daemon running.

## Steps

1. Open `/settings/routines` (the older `/connections/routines` URL
   redirects here).
2. Click "Add custom routine".
3. Fill the form:
   - **Slug** — kebab-case (e.g. `tuesday-notion-sweep`); becomes the
     ProcessKey `routine.custom.<slug>` and the file name
     `policies/routines/custom/<slug>.md`.
   - **Cron expression** — standard 5-field cron (e.g. `0 11 * * 2`).
     The form previews the next three fires.
   - **Backend tier** — `light` or `heavy`. Custom routines have no
     concrete model picker; tier determines which model the
     BackendRouter resolves at fire time.
   - **Max budget USD** — per-execute cap (default `0.05`).
   - **Description** — free-text. Becomes the body of the generated
     vault file under `## Checks`. Edit the file later to refine the
     check list.
4. Save. The dashboard writes the vault file; the next-fire timestamp
   appears in the routine table.

## Verification

- Wait for the cron to fire; check Activity for the row tagged
  `routine.custom.<slug>`.

## If It Fails

- A cron that resolves to "never": the dashboard refuses to save it.
- A prompt that hits absolute-block guardrails: the routine fires
  but the offending tool call is logged as `blocked_absolute`.

## Related

- [Custom Routines](../features/routines/custom-routines.md)
