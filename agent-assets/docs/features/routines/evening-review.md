---
schema_version: 1
slug: features/routines/evening-review
title: Evening Review
id: evening-review
aliases:
  - evening routine
  - end of day
  - retro
category: features
summary: |
  The evening review fires once per day at 18:00 local time. It writes
  the day's retrospective into the agent journal and rolls up unfinished
  items for tomorrow's plan.
section: routines
tags:
  - routines
  - autonomous
  - daily
  - light-tier
status: stable
ask_examples:
  - When does the evening review run?
  - What does the evening review write?
  - How do I disable it?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - evening review
  - retro
  - end of day
related:
  - concepts/routines
  - features/memory-files/agent-journal
  - features/routines/morning-routine
process_keys:
  - routine.evening_review
---

# Evening Review

## In One Sentence

A light-tier routine that fires daily at 18:00 local time and writes
the day's retro into the journal.

## What It Does

- Reads the day's `state/today.md`, the journal entries, the activity feed.
- Writes a short retrospective into `journal/agent.md`.
- Surfaces uncompleted carry-over items the morning routine should
  re-pick-up tomorrow.

## When It Runs / How It Is Triggered

Every day at **18:00 local time**, exactly once. The cron expression
is fixed in `packages/daemon/src/core/scheduler.ts` and is not
operator-configurable.

## What It Outputs

- An `journal/agent.md` entry.
- A "today wraps up here" notification (subject to quiet hours).

## Where in the Dashboard

- **Connections → Journal** shows the appended entry.

## Configuration

This routine has no operator-tunable knobs. The fire time and tier
are fixed in code.

## When Something Goes Wrong

- A journal that **stops growing**: see [Auth Failed](../../troubleshooting/auth-failed.md) — the routine may be hitting a quota wall.

## Related

- [agent/journal.md](../memory-files/agent-journal.md)
