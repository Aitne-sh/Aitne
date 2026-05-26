---
schema_version: 1
slug: features/memory-files/schedule
title: daily/ files
id: schedule-files
aliases:
  - schedule directory
  - daily directory
  - per-date schedule
  - daily/YYYY-MM-DD.md
category: features
summary: |
  Per-date synthesis files (daily/YYYY-MM-DD.md) the morning routine
  writes from yesterday.md plus the SQLite event log. They are the
  read-only archive each day rolls into; the dashboard's Schedule view
  also reads them.
section: memory-files
tags:
  - memory
  - schedule
  - core
status: stable
ask_examples:
  - Where does the agent store the day's archived plan?
  - Why is yesterday still showing up in /schedule?
  - How do I hand-edit a day's plan?
locale: en-US
created: 2026-04-25
updated: 2026-04-26
keywords:
  - schedule
  - daily
  - per-date
  - calendar snapshot
related:
  - features/routines/morning-routine
  - features/memory-files/today
  - concepts/agent-day
ui_anchors:
  - /schedule
context_files:
  - daily/<date>.md
---

# daily/ Files

## In One Sentence

`daily/YYYY-MM-DD.md` is the morning routine's synthesized archive of
the agent-day; the dashboard's Schedule view and downstream routines
read from this directory.

> **Heads up — directory renamed.** The mechanical
> `schedule/YYYY-MM-DD.md` copy was retired in B-007. The morning
> routine now synthesizes `daily/YYYY-MM-DD.md` from `state/yesterday.md`
> plus the SQLite event log instead. Hand-pruning the old `schedule/`
> directory is safe.

## What It Does

Each file under `~/.personal-agent/context/daily/` corresponds to one
**agent day** (the file name uses the agent-day date, not the calendar
date — see [Agent Day](../../concepts/agent-day.md)). The morning
routine writes the file shortly after rolling `state/today.md` →
`state/yesterday.md`. It contains:

- Calendar events from connected calendars.
- Mail-driven items the agent flagged for that day.
- Preparation Timeline rows from `plans/roadmap.md` whose offset fired that day.
- Carryover items the agent did not finish.

The synthesis is template-driven and reads from the in-process DB
snapshot of the closing `state/today.md` plus the day's event records, so
late edits made directly to `state/today.md` after rotation cannot retroactively
rewrite a previous `daily/` file.

## When It Runs / How It Is Triggered

The morning routine writes today's file once at start-of-day. Other
routines read it but do not rewrite.

## What It Outputs

- A Markdown file with sections for events, preparations, and
  carryover items.
- A `last_updated` line so the dashboard knows freshness.

## Where in the Dashboard

- **Schedule (`/schedule`)** reads adjacent `daily/<date>.md` files
  to render the past/today/upcoming columns. Hand-edits are picked up
  on the next view refresh.

## Configuration

There is nothing to configure on these files directly; they are a
side effect of the morning routine. Retention is unlimited — old
files accumulate. A manual prune (`rm daily/2025-*.md`) is safe.

## When Something Goes Wrong

- An **empty** daily file usually means the morning routine did not
  run. See [Morning Routine Didn't Run](../../troubleshooting/morning-routine-didnt-run.md).
- A view that **shows yesterday** is the day-boundary subtlety:
  before `dayBoundaryHour`, the agent day is still yesterday. See
  [Agent Day](../../concepts/agent-day.md).

## Related

- [Morning Routine](../policies/routines/morning-routine.md) — the writer.
- [today.md](today.md) — the live, hand-editable surface for the
  current agent day.
