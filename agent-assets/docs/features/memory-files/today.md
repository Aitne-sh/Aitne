---
schema_version: 1
slug: features/memory-files/today
title: today.md
id: today-md
aliases:
  - today
  - day plan
category: features
summary: |
  today.md is the live plan for the current agent day. The morning
  routine rebuilds it each day; the hourly check, evening review,
  and the operator all read and append to it during the day.
section: memory-files
tags:
  - core
  - memory
  - today
status: stable
ask_examples:
  - What is in today.md?
  - Can I edit today.md by hand?
  - Why does today.md keep getting rewritten?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - today
  - day plan
  - agent log
  - handoff
related:
  - features/routines/morning-routine
  - features/routines/hourly-check
  - features/routines/evening-review
  - features/memory-files/schedule
  - concepts/agent-day
ui_anchors:
  - /knowledge?tab=context-files
api_endpoints:
  - PUT /api/context/*
  - PATCH /api/context/*
context_files:
  - state/today.md
---

# today.md

## In One Sentence

The single live file for the current agent day — plan, log, tasks, and
hand-off. The morning routine rebuilds it; everything else during the
day appends to it.

## What It Does

today.md holds six sections, written in this order:

- **User Schedule** — the day's calendar events.
- **User Tasks** — today's external tasks plus agent-tracked to-dos.
- **Agent Plan** — what the agent intends to work on today (each row is
  registered as a schedule entry by the morning routine).
- **Agent Notes** — look-ahead items and date-bound memos folded in from
  inbox triage.
- **Agent Log** — what actually happened, appended throughout the day.
- **Handoff** — what carries over to tomorrow.

## When It Runs / How It Is Triggered

- The **morning routine** fully rebuilds today.md (the daemon first
  rotates the previous day's file to `state/yesterday.md`).
- The **hourly check** routes new observations into the right section
  and appends short status lines under Agent Log.
- The **evening review** finalizes the file — it updates Agent Log and
  the Handoff section before writing the daily journal.

## How It Is Written

The agent never edits today.md with a file tool. All writes go through
the daemon's context API — `PUT`/`PATCH /api/context/state/today` (the
canonical, class-prefixed path). A `today-write-lock` serializes writes
during the morning routine: while the lock is held, a write to
`state/today` must carry the `X-Lock-Id` header or it is rejected.

## Where in the Dashboard

- **Knowledge → Context Files → today.md** to view and edit by hand.

## When Something Goes Wrong

- An empty today.md after the morning hour: see
  [Morning routine didn't run](../../troubleshooting/morning-routine-didnt-run.md).

## Related

- [Morning routine](../routines/morning-routine.md)
- [Hourly check](../routines/hourly-check.md)
- [Evening review](../routines/evening-review.md)
- [schedule/ files](schedule.md)
