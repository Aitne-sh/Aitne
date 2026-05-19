---
schema_version: 1
slug: concepts/agent-day
title: Agent Day
id: agent-day
aliases:
  - day boundary
  - 04:00 boundary
  - agent day boundary
category: concepts
summary: |
  Aitne rolls over the "day" at 04:00 local time, not midnight, so
  late-night work belongs to the day it started in. This shifted boundary
  drives every routine schedule and date-stamped memory file.
section: agent-day
tags:
  - core
  - timing
  - memory
  - routines
status: stable
ask_examples:
  - When does the agent day actually roll over?
  - Why is my late-night work showing up under yesterday?
  - How do I change the day boundary?
  - What is dayBoundaryHour?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
keywords:
  - day boundary
  - 04:00
  - dayBoundaryHour
  - rollover
  - agent day
  - getAgentDayBoundsUtc
  - getAgentDayDateStr
related:
  - features/routines/morning-routine
  - features/memory-files/today
ui_anchors:
  - /settings
config_keys:
  - dayBoundaryHour
---

# Agent Day

## TL;DR

Aitne treats the "day" as starting at **04:00 local time**, not
00:00. Anything you log between midnight and 4am is filed under the day
that just ended, so a late commit at 02:30 lands in the same `today.md`
that opened the previous morning.

## Why This Concept Exists

Owner-as-user installations almost always have late-night work sessions
that, mentally, belong to "today" even though the wall-clock has already
ticked over. A day boundary at midnight would split a single coherent
working session across two `today.md` files, and the morning routine
would open against an empty schedule because no agent activity had been
logged for the new calendar day yet.

Picking 04:00 is a defensive default: late enough to capture even very
late nights, early enough that an early-rising operator (5–6am) sees a
clean boundary before they start.

## Definitions

- **Agent day**: the 24-hour window starting at the configured day-boundary hour and ending at the same hour the next calendar day.
- **Day boundary**: the hour-of-day that starts the agent day. Configured via the `dayBoundaryHour` setting (default `4`).
- **Day-stamped file**: any file whose name includes `YYYY-MM-DD` (e.g. `daily/2026-04-25.md`, `weekly/2026-04-20.md`). The date stamp uses the agent-day boundary, not the calendar day.

## Concrete Examples

| Wall-clock time | Calendar date | Agent day |
|---|---|---|
| 2026-04-25 02:30 | April 25 | April 24 (late session) |
| 2026-04-25 04:30 | April 25 | April 25 |
| 2026-04-25 23:50 | April 25 | April 25 |
| 2026-04-26 03:55 | April 26 | April 25 (still!) |

## Where You See It in the Dashboard

- The Schedule view labels each day's column by **agent day**, so a 02:30 calendar entry appears under the previous day's header.
- Activity → Conversations groups sessions by agent day for the same reason.
- Cost analytics roll up by agent day so a late-night research binge does not split into two separate "days" of spend.

## Related

- [Morning Routine](../features/routines/morning-routine.md) opens at the day boundary's morning-routine hour, not midnight.
- [today.md](../features/memory-files/today.md) is rebuilt once per agent day, anchored on the boundary.
