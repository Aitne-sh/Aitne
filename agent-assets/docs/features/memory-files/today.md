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
  today.md is the live, hand-editable plan for the current agent day.
  The morning routine writes it; the operator and the agent both
  append to it during the day.
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
updated: 2026-04-25
keywords:
  - today
  - day plan
related:
  - features/routines/morning-routine
  - features/memory-files/schedule
  - concepts/agent-day
context_files:
  - today.md
---

# today.md

## In One Sentence

The single live file that captures the day's plan, log, tasks, and
hand-off — rebuilt by the morning routine, appended-to by everything
else during the day.

## What It Does

Sections:

- **User Schedule** — calendar events.
- **Tasks** — today's external + agent-tracked tasks.
- **Agent Plan** — what the agent intends to work on today.
- **Agent Log** — what actually happened.
- **Handoff** — what carries to tomorrow.

## When It Runs / How It Is Triggered

- The morning routine fully rewrites it.
- The hourly check appends short observations under Agent Log.
- The evening review reads it before writing the journal.

## Where in the Dashboard

- **Knowledge → Context Files → today.md** to view and edit.

## When Something Goes Wrong

- An empty today.md after the morning hour: see [Morning Routine
  Didn't Run](../../troubleshooting/morning-routine-didnt-run.md).

## Related

- [Morning Routine](../routines/morning-routine.md)
- [schedule/ files](schedule.md)
