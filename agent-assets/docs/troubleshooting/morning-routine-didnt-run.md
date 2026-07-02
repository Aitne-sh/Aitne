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
  The morning routine produced no fresh state/today.md and no briefing.
  Causes are ordered by frequency: daemon was stopped at the trigger
  time, both backends failed, quota exhausted, the routine threw and is
  mid-retry, or it is a day-boundary subtlety. Most cases self-heal via
  boot/wake catch-up, the missed-fire self-heal, or the retry chain.
section: morning-routine-didnt-run
tags:
  - routines
  - autonomous
  - scheduler
  - routing
status: stable
ask_examples:
  - Why didn't my morning routine fire?
  - Why is today.md empty?
  - How do I regenerate today.md by hand?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - morning routine didn't run
  - morning routine skipped
  - morning routine gate
  - empty today.md
  - regenerate today
related:
  - features/routines/morning-routine
  - features/routines/activity-scan
  - concepts/agent-day
  - troubleshooting/auth-failed
  - troubleshooting/quota-exhausted
process_keys:
  - routine.morning_routine
  - routine.morning_routine_today
  - routine.morning_routine_journal
api_endpoints:
  - POST /api/agent/regenerate
config_keys:
  - dayBoundaryHour
context_files:
  - state/today.md
ui_anchors:
  - /agents/morning-routine
  - /activity
---

# Morning Routine Didn't Run

## What You See

- An empty or stale `state/today.md`.
- No morning notification.
- Activity has no `routine.morning_routine` row for today.

## Before You Worry: It Often Self-Heals

The morning routine has several recovery paths that usually fix this
without any action from you:

- **Boot-time catch-up.** If the daemon was stopped during the trigger
  window, it fires the unrun morning routine the next time it starts.
  So a missed routine often resolves itself on the next `aitne start`
  or `aitne restart`.
- **Sleep wake catch-up.** If the machine was asleep at the trigger
  minute (laptop lid closed at 04:00), the scheduled trigger is
  silently lost — the scheduler (cron) never replays a tick it missed.
  When the machine wakes, the daemon spots the gap in wall-clock time
  and queues the morning routine itself, along with any missed evening
  or weekly reviews.
- **Missed-fire self-heal.** A periodic check (every 10 minutes)
  notices when the day is more than ~15 minutes old with no morning
  attempt and nothing queued, and queues the routine. This covers
  sleeps too short for the wake detector and any other lost trigger.
- **Retry on failure.** If the routine runs but fails to produce a
  fresh `state/today.md`, the daemon retries up to 3 times, waiting a
  little longer between each try (5, then 10, then 15 minutes). After 3
  failed attempts it sends you a DM asking you to regenerate manually.
- **Hung-run recovery.** If a run starts and then gets stuck (usually
  the machine sleeps mid-run and drops the backend connection), the
  self-heal check re-queues it once the run has stayed silent past the
  stall threshold (~2 hours by default) — at most twice per day, after
  which it alerts you instead of re-running. Either way you get an owner
  DM, so the silence never goes unnoticed.

Give it a few minutes, or restart the daemon, before digging deeper.

## Most Likely Causes (in probability order)

1. **Daemon was stopped — or the machine was asleep — at the trigger
   time.** Check `aitne status`. Boot-time catch-up covers the stopped
   case once the daemon is back up; sleep wake catch-up and the
   missed-fire self-heal cover the asleep case within minutes of the
   machine waking.
2. **Both backends failed.** The routine tried the main backend, fell
   back, and the fallback failed too. Check `/activity` for an error
   outcome and `aitne logs` for the failure.
3. **Quota exhausted on both backends.** The morning routine runs on
   the medium tier (Sonnet by default for Claude); a backend that is
   out of quota fails over, and if the fallback is also out you get no
   run. See [Quota Exhausted](quota-exhausted.md).
4. **Mid-retry.** The routine threw and is in the 5/10/15-minute
   retry window — the row may simply not have landed yet.
5. **Day-boundary subtlety.** Before the agent-day boundary (the moment
   "today" rolls over, set by `dayBoundaryHour`, default 04:00), the
   routine still "belongs to" yesterday — see
   [Agent Day](../concepts/agent-day.md).

Note: the morning routine takes priority over the activity scan, not the
other way around. The activity scan skips itself while the morning
routine is active, so a running activity scan never blocks the morning
routine.

## Diagnostic Steps

1. `aitne status` — is the daemon up?
2. `/activity` — is there a row for `routine.morning_routine`? An error
   outcome points to a backend failure (cause 2 or 3).
3. `/agents` — the morning-routine card shows its schedule, status,
   and last run; open `/agents/morning-routine` for recent executions.
4. `aitne logs` — search for `morning_routine` to see the trigger,
   any fallback, and retry scheduling.

## Forcing a Regenerate

If you want today's `state/today.md` rebuilt right now, click
**Regenerate** on the dashboard (it POSTs to `/api/agent/regenerate`
with `target: today`). This bypasses the schedule and runs the
synthesis immediately.

## Confirming the Fix

- The next morning's routine fires shortly after `dayBoundaryHour`
  (default 04:00).
- `/activity` shows a `routine.morning_routine` row with a non-error
  outcome.

## When None of the Above Help

- Open an issue with a redacted excerpt of the daemon log around the
  expected fire time.

## Related

- [Morning Routine](../features/routines/morning-routine.md)
- [Activity Scan](../features/routines/activity-scan.md)
- [Agent Day](../concepts/agent-day.md)
