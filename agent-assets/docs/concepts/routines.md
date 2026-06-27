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
  its own — morning routine, evening review, activity scan, weekly
  retro, plus any recurring user Agents you define.
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
updated: 2026-06-07
keywords:
  - routine
  - routines
  - cron
  - autonomous
  - scheduler
  - routine.fetch_window
  - pre-pass
  - dayBoundaryHour
  - activity scan
related:
  - features/routines/morning-routine
  - features/routines/evening-review
  - features/routines/weekly-review
  - features/routines/activity-scan
  - guides/add-a-custom-routine
  - concepts/process-keys
  - concepts/observations
ui_anchors:
  - /agents
  - /agents/activity-scan
process_keys:
  - routine.morning_routine
  - routine.morning_routine_today
  - routine.morning_routine_journal
  - routine.evening_review
  - routine.weekly_review
  - routine.monthly_review
  - routine.activity_scan
  - routine.today_refresh
  - routine.fetch_window
  - routine.activity_scan.triage
config_keys:
  - dayBoundaryHour
  - activityScanEnabled
  - activityScanIntervalMinutes
  - activityScanActiveStartHour
  - activityScanActiveEndHour
  - activityScanPrePassFreshnessMinutes
  - activityScanStage2Enabled
  - monthlyReviewEnabled
---

# Routines

## TL;DR

A routine is a unit of agent work that runs on a schedule, not in
response to a message. The morning routine fires once per agent day at
`dayBoundaryHour`; the evening review (18:00 daily), weekly review
(Friday 19:00), and optional monthly review fire on fixed schedules in
code; the activity scan coalesces accumulated observations on a
configurable cadence.

## Why This Concept Exists

The premise of Aitne is that the operator does not want to
"prompt" their assistant every time. Routines are how the agent shows
up without being asked: it builds today, it logs to the journal, it
files a retro for the week. They are the proactive surface.

Each routine is a single ProcessKey — `routine.morning_routine`,
`routine.activity_scan`, `routine.weekly_review`, etc. The dispatcher
treats them as just another event class; the only difference from a
DM is who fired the event.

## Definitions

- **Routine**: one autonomous job firing at a schedule. Identified by
  a ProcessKey starting with `routine.`.
- **Agent day**: the 24-hour window starting at `dayBoundaryHour`
  (default 04:00) — see [Agent Day](agent-day.md).
- **Catch-up**: if the daemon was offline at the trigger time, a
  boot-time check re-fires any routine whose window has already
  opened but never ran (morning routine within the agent day; evening
  review once it is past 18:00; weekly review across Fri–Sun). It never
  double-fires a routine that already succeeded.
- **Tier policy**: **no routine runs the high tier by default.** Every
  recurring routine — morning, evening, weekly, activity scan —
  defaults to **medium** (Sonnet on Claude). The **lite** (Haiku) tier
  is reserved for the morning routine's Stage B and for mechanical
  sub-jobs (the activity-scan triage gate and the pre-pass fetcher). The
  only high-tier ProcessKey in the whole system is `delegated_task_heavy`,
  which is opt-in and not a routine. See
  [Backends and Tiers](backends-and-tiers.md).
- **Two-stage morning routine**: the morning routine runs as a parent
  envelope `routine.morning_routine` (medium) that fans out two stages
  in parallel — Stage A `routine.morning_routine_today` (medium, builds
  `state/today.md`) and Stage B `routine.morning_routine_journal` (lite,
  authors the previous day's journal). The legacy heavy-tier
  `routine.morning_routine_initial` first-run branch was retired in
  Phase 7 (2026-05-16); a first run is now detected inline from a
  missing `state/yesterday.md` and handled by the same medium-tier
  parent with a daemon-prepared `<roadmap_skeleton>` block.
- **Pre-pass fetcher**: each main routine that needs fresh mail /
  calendar / Notion data is preceded by a lite-tier
  `routine.fetch_window` session that fetches the relevant window and
  POSTs observations. The main routine then consumes the resulting
  `<fetch_report>` block plus pending observations instead of hitting
  upstream APIs itself — a cost-savings split introduced in 2026-05.

## Concrete Examples

| ProcessKey | When | Tier |
|---|---|---|
| `routine.morning_routine` | `dayBoundaryHour` daily (parent envelope; first-run branch detected inline from missing `state/yesterday.md`) | medium |
| `routine.morning_routine_today` | Stage A of every morning routine (today.md synthesis + roadmap maintenance + schedule fan-out) | medium |
| `routine.morning_routine_journal` | Stage B of every morning routine (`journal/daily/<yesterday>.md` authoring) | lite |
| `routine.evening_review` | 18:00 daily (fixed) | medium |
| `routine.weekly_review` | Friday 19:00 (fixed, one hour after evening review) | medium |
| `routine.monthly_review` | Last day of month at 18:00, **default off** — opt in by enabling the monthly-review agent at `/agents/monthly-review` | medium |
| `routine.activity_scan` | Every N interval minutes (default 60) inside the active window — cadence set on `/agents/activity-scan` | medium |
| `routine.today_refresh` | On calendar drift or a dashboard "refresh today" request (not a fixed cron) | medium |
| `routine.fetch_window` | Spawned before each routine above that needs fresh upstream data | lite |
| `routine.activity_scan.triage` | Stage 2 of the activity-scan gate on low-signal ticks — runs only when `activityScanStage2Enabled` is on (default off; disabled ticks escalate straight to the full check) | lite |
| `routine.custom.<slug>` | Legacy custom-routine recurrence — custom routines are now user Agents created on `/agents`; existing specs were converted at upgrade | medium |

## Where You See It in the Dashboard

- **Agents** (`/agents`) is the hub: every routine is an agent card
  showing its schedule, status, and last run. The activity scan's
  cadence and active window are edited on `/agents/activity-scan`
  (Definition tab → Cadence card); each routine's rulebook is edited
  on its Rulebook tab; custom recurring work is a user agent created
  from the same page's New Agent dialog. Morning, evening, weekly, and
  monthly fire times are fixed in code and not editable there.
- **Activity** logs each routine run with its outcome.

## Related

- [Morning Routine](../features/routines/morning-routine.md)
- [Evening Review](../features/routines/evening-review.md)
- [Activity Scan](../features/routines/activity-scan.md)
- [Create a Recurring Agent](../guides/add-a-custom-routine.md)
- [Custom Routines (Retired)](../features/routines/custom-routines.md)
