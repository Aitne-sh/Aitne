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
  - memory
  - routines
  - scheduler
status: stable
ask_examples:
  - When does the agent day actually roll over?
  - Why is my late-night work showing up under yesterday?
  - How do I change the day boundary?
  - What is dayBoundaryHour?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
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
  - /settings/hours
config_keys:
  - dayBoundaryHour
---

# Agent Day

## TL;DR

Aitne starts each "day" at **04:00 local time**, not at 00:00. In other
words, the agent-day boundary (the moment "today" rolls over) sits at 4am
by default. Anything you do between midnight and 4am counts toward the day
that is just ending, so a late commit at 02:30 lands in the same
`state/today.md` that opened the previous morning.

## Why This Concept Exists

Most people who run Aitne for themselves work late into the night. Those
sessions still feel like "today" to you, even after the clock has ticked
past midnight. A boundary at midnight would cut one continuous work session
in half, spreading it across two `state/today.md` files. It would also leave
the morning routine with nothing to open against: no agent activity has been
logged yet for the fresh calendar day.

04:00 is a safe default. It is late enough to capture even very late nights,
yet early enough that an early riser (someone up at 5–6am) still starts the
day on the far side of a clean boundary.

## Definitions

- **Agent day**: the 24-hour window starting at the configured day-boundary hour and ending at the same hour the next calendar day.
- **Day boundary**: the hour-of-day that starts the agent day. Configured via the `dayBoundaryHour` setting (default `4`, valid range `0`–`9`). Values above 9 are rejected — the boundary is intended for the small hours, not mid-day.
- **Day-stamped file**: any file whose name carries a date (e.g. `journal/daily/2026-04-25.md` with a `YYYY-MM-DD` stamp, `journal/weekly/2026-W17.md` with an ISO `YYYY-Www` week slug). The stamp uses the agent-day boundary, not the calendar day.

## Concrete Examples

| Wall-clock time | Calendar date | Agent day |
|---|---|---|
| 2026-04-25 02:30 | April 25 | April 24 (before boundary) |
| 2026-04-25 04:30 | April 25 | April 25 (after boundary) |
| 2026-04-25 23:50 | April 25 | April 25 (normal) |
| 2026-04-26 03:55 | April 26 | April 25 (before boundary) |

## Where You See It in the Dashboard

- Analytics → Cost rolls up spend by agent day — both the "Today" card and the per-day buckets use the shifted boundary — so a late-night research binge does not split into two separate "days" of spend.
- The Hours & Notifications time-axis ring marks the day boundary with a dashed blue line, alongside quiet hours and the activity scan's active window.
- To change the boundary, open **Settings → Hours & Notifications** (`/settings/hours`) and edit the day-boundary hour.

## Related

- [Morning Routine](../features/routines/morning-routine.md) opens shortly after the day boundary as part of the morning routine, not at midnight.
- [today.md](../features/memory-files/today.md) is rebuilt once per agent day, anchored on the boundary.
