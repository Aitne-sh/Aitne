---
schema_version: 1
slug: concepts/routines
title: Routines
id: routines
aliases:
  - autonomous routines
  - cron
  - scheduled work
  - routine pre-pass
  - morning routine
  - evening review
category: concepts
summary: |
  Routines are the autonomous, scheduled tasks Aitne runs on
  its own — morning routine, evening review, hourly check, weekly
  retro, plus any custom routines you define.
section: routines
tags:
  - core
  - routines
  - autonomous
  - scheduler
status: stable
ask_examples:
  - What routines does the agent run automatically?
  - How do I disable a routine?
  - Can I add my own routine?
  - What is the routine pre-pass fetcher?
  - Which routine uses the high tier by default?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
keywords:
  - routine
  - routines
  - cron
  - autonomous
  - scheduler
  - routine.fetch_window
  - pre-pass
  - dayBoundaryHour
  - hourly check
related:
  - features/routines/morning-routine
  - features/routines/evening-review
  - features/routines/weekly-review
  - features/routines/hourly-check
  - features/routines/custom-routines
  - concepts/process-keys
  - concepts/observations
ui_anchors:
  - /connections/routines
  - /settings/routines
config_keys:
  - dayBoundaryHour
  - hourlyCheckEnabled
  - hourlyCheckIntervalMinutes
  - hourlyCheckPrePassFreshnessMinutes
  - activeHoursStart
  - activeHoursEnd
  - monthlyReviewEnabled
---

# Routines

## TL;DR

A routine is a unit of agent work that runs on a schedule, not in
response to a message. The morning routine fires once per agent day at
`dayBoundaryHour`; evening and weekly retros fire on fixed schedules
in code; the hourly check coalesces accumulated observations on a
configurable cadence.

## Why This Concept Exists

The premise of Aitne is that the operator does not want to
"prompt" their assistant every time. Routines are how the agent shows
up without being asked: it builds today, it logs to the journal, it
files a retro for the week. They are the proactive surface.

Each routine is a single ProcessKey — `routine.morning_routine`,
`routine.hourly_check`, `routine.weekly_review`, etc. The dispatcher
treats them as just another event class; the only difference from a
DM is who fired the event.

## Definitions

- **Routine**: one autonomous job firing at a schedule. Identified by
  a ProcessKey starting with `routine.`.
- **Agent day**: the 24-hour window starting at `dayBoundaryHour`
  (default 04:00) — see [Agent Day](agent-day.md).
- **Catch-up**: if the daemon was offline at the trigger time, the
  scheduler re-fires the routine on next launch when it is still in
  the same agent day.
- **Tier policy**: no routine runs heavy by default. The morning
  routine's first-run branch ran on heavy until
  `docs/design/appendices/morning-routine-optimization.md` Phase 7
  (2026-05-16) retired `routine.morning_routine_initial`; the
  first-run branch now uses the medium-tier parent
  `routine.morning_routine` with a daemon-prepared
  `<roadmap_skeleton>` block. Every recurring routine — morning,
  evening, weekly, hourly check — defaults to **medium**
  (Sonnet on Claude). The morning routine itself is a two-stage
  pipeline: Stage A `routine.morning_routine_today` (medium) runs
  in parallel with Stage B `routine.morning_routine_journal` (lite).
  The lite (Haiku) tier is reserved for Stage B plus mechanical
  sub-jobs (the hourly-check triage gate and the pre-pass fetcher).
  See [Backends and Tiers](backends-and-tiers.md).
- **Pre-pass fetcher**: each main routine that needs fresh mail /
  calendar / Notion data is preceded by a lite-tier
  `routine.fetch_window` session that fetches the relevant window and
  POSTs observations. The main routine consumes the resulting
  `<fetch_report>` block plus pending observations instead of
  fetching upstream APIs itself. This is the cost-savings split
  introduced in 2026-05.

## Concrete Examples

| ProcessKey | When | Tier |
|---|---|---|
| `routine.morning_routine` | `dayBoundaryHour` daily (parent envelope; first-run branch detected inline from missing `state/yesterday.md`) | medium |
| `routine.morning_routine_today` | Stage A of every morning routine (today.md synthesis + roadmap maintenance + schedule fan-out) | medium |
| `routine.morning_routine_journal` | Stage B of every morning routine (daily/<yesterday>.md authoring) | lite |
| `routine.today_refresh` | Every 4h inside the active window | medium |
| `routine.evening_review` | 18:00 daily (fixed) | medium |
| `routine.hourly_check` | Every `hourlyCheckIntervalMinutes` (default 60) inside the active window | medium |
| `routine.weekly_review` | Friday 18:00 (fixed) | medium |
| `routine.fetch_window` | Spawned before each routine above | lite |
| `routine.hourly_check.triage` | Stage 2 gate of every hourly check | lite |
| `routine.custom.<slug>` | Operator-defined recurrence | configurable |

## Where You See It in the Dashboard

- **Settings → Routines** is where the hourly check active window, the
  hourly check cadence, and any custom routines live. Morning, evening,
  and weekly fire times are fixed in code and not surfaced here.
- **Connections → Routines** is the unified view of next-fire times.
- **Activity** logs each routine run with its outcome.

## Related

- [Morning Routine](../features/routines/morning-routine.md)
- [Evening Review](../features/routines/evening-review.md)
- [Hourly Check](../features/routines/hourly-check.md)
- [Custom Routines](../features/routines/custom-routines.md)
