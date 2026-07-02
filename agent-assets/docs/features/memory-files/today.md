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
  routine rebuilds it each day; the activity scan, evening review,
  and the operator all read and append to it during the day.
section: memory-files
tags:
  - memory
status: stable
ask_examples:
  - What is in today.md?
  - Can I edit today.md by hand?
  - Why does today.md keep getting rewritten?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - today
  - day plan
  - agent log
  - handoff
related:
  - features/routines/morning-routine
  - features/routines/activity-scan
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

The single live file for the current agent day (the window the agent
treats as "today") — its plan, log, tasks, and hand-off. The morning
routine rebuilds it fresh each day; everything else during the day only
appends to it.

## What It Does

today.md holds six sections, written in this order:

- **User Schedule** — the day's calendar events.
- **User Tasks** — today's external tasks plus agent-tracked to-dos.
- **Agent Plan** — what the agent means to work on today. The morning
  routine turns each row into a schedule entry; a later session that day
  can add rows for new signals or drop a row whose reason no longer
  holds.
- **Agent Notes** — upcoming items and date-specific memos pulled in from
  inbox triage (the sorting of new incoming items).
- **Agent Log** — what actually happened, appended throughout the day.
- **Handoff** — what carries over to tomorrow.

## When It Runs / How It Is Triggered

- The **morning routine** fully rebuilds today.md (the daemon first
  rotates the previous day's file to `state/yesterday.md`).
- The **activity scan** routes new observations into the right section
  and appends short status lines under Agent Log.
- The **evening review** closes out the file — it updates Agent Log and
  the Handoff section. (The daily journal itself is written the next
  morning, from the rotated file.)

## How It Is Written

The agent never edits today.md with a file tool. Every write goes
through the daemon's context API — `PUT`/`PATCH /api/context/state/today`
(the canonical, class-prefixed path). A `today-write-lock` forces writes
to happen one at a time during the morning routine: while the lock is
held, any write to `state/today` must carry the `X-Lock-Id` header, or
it is rejected.

## Where in the Dashboard

- **Knowledge → Context Files → today.md** to view and edit by hand.

## When Something Goes Wrong

- An empty today.md after the morning hour: see
  [Morning routine didn't run](../../troubleshooting/morning-routine-didnt-run.md).

## Related

- [Morning routine](../routines/morning-routine.md)
- [Activity scan](../routines/activity-scan.md)
- [Evening review](../routines/evening-review.md)
- [schedule/ files](schedule.md)
