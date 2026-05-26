---
schema_version: 1
slug: troubleshooting/morning-routine-didnt-run
title: Morning Routine Didn't Run
id: morning-routine-didnt-run
aliases:
  - morning routine missed
  - empty today
  - no morning briefing
category: troubleshooting
summary: |
  The most common operator pain. Causes are ordered by frequency:
  daemon was stopped, fallback failed, quota exhausted, schedule
  configuration mismatch, day-boundary subtlety.
section: morning-routine-didnt-run
tags:
  - troubleshooting
  - routines
  - autonomous
status: stable
ask_examples:
  - Why didn't my morning routine fire?
  - Why is today.md empty?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - morning routine didn't run
  - morning routine skipped
  - morning routine gate
related:
  - features/routines/morning-routine
  - troubleshooting/auth-failed
  - troubleshooting/quota-exhausted
---

# Morning Routine Didn't Run

## What You See

- An empty or stale `state/today.md`.
- No morning notification.
- Activity has no `routine.morning_routine` row for today.

## Most Likely Causes (in probability order)

1. **Daemon was stopped at the trigger time.** Check `aitne status`.
2. **Fallback failed too.** Look for a `fallback-failed` notification.
3. **Heavy-tier quota exhausted on both backends.** See
   [Quota Exhausted](quota-exhausted.md).
4. **Hourly check skip-gate fired during the trigger window.** The
   morning routine and the hourly check share an atomic flag — if the
   hourly check was already running at the rollover instant, the
   morning routine won't double-fire.
5. **Day-boundary subtlety.** Before `dayBoundaryHour`, the routine
   still "belongs to" yesterday — see
   [Agent Day](../concepts/agent-day.md).

## Diagnostic Steps

1. `aitne status` — daemon up?
2. `/activity` — any row for `routine.morning_routine`?
3. `/settings/routines` — the routine list shows the next scheduled
   fire and recent runs.
4. `aitne logs` — search for `morning_routine`.

## Confirming the Fix

- The next morning's routine fires within 60 seconds of
  `dayBoundaryHour` (default 04:00).
- Activity shows the row with a non-error outcome.

## When None of the Above Help

- Open an issue with a redacted excerpt of the daemon log around the
  expected fire time.

## Related

- [Morning Routine](../features/routines/morning-routine.md)
