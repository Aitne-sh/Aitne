---
schema_version: 1
slug: features/routines/morning-routine
title: Morning Routine
id: morning-routine
aliases:
  - morning_routine
  - daily morning routine
  - morning report
  - morning briefing
category: features
summary: |
  The autonomous routine that runs once per agent-day at the configured
  morning hour to produce today.md and the day's plan.
section: routines
tags:
  - routines
  - autonomous
  - daily
  - core
status: stable
ask_examples:
  - When does morning routine run?
  - How do I disable morning routine?
  - Where does its output go?
  - What model does morning routine use?
locale: en-US
created: 2026-04-25
updated: 2026-05-17
keywords:
  - morning
  - day plan
  - 04:00
  - day boundary
related:
  - concepts/agent-day
  - features/memory-files/today
prerequisites:
  - concepts/agent-day
ui_anchors:
  - /settings/routines
  - /
process_keys:
  - routine.morning_routine
  - routine.morning_routine_today
  - routine.morning_routine_journal
config_keys:
  - dayBoundaryHour
context_files:
  - today.md
  - daily/<date>.md
---

# Morning Routine

## In One Sentence

Once per agent day, at `dayBoundaryHour` local time, Aitne
rebuilds `today.md` and the day's schedule from your calendar, mail,
roadmap, and recent observations.

## What It Does

The morning routine is the single highest-value process in Aitne.
It runs as a **two-stage pipeline** — Stage A (`routine.morning_routine_today`)
on the medium tier rebuilds `today.md`, walks the roadmap, fans out
the day's schedule, and self-reports structured metadata; Stage B
(`routine.morning_routine_journal`) on the lite tier authors
`daily/<yesterday>.md` in parallel from a daemon-prepared skeleton.
Every downstream routine for the next 24 hours reads Stage A's
output, so a bad morning briefing still degrades the entire day —
hence the medium-tier ceiling on Stage A even after the split.

In sequence, the routine:

1. Reads the previous day's `today.md` and rolls forward unfinished items.
2. Pulls today's calendar events from any connected calendar integration.
3. Scans recent unread mail and surfaces the few that need owner attention.
4. Walks the roadmap looking for items whose **Preparation Timeline** rows fire today.
5. Consumes any pending observations the hourly check has already dropped into the queue.
6. Writes the rebuilt `today.md` and the per-date snapshot at `daily/YYYY-MM-DD.md`.
7. Logs a single status line to the dashboard activity feed.

## When It Runs / How It Is Triggered

The morning routine fires at **`dayBoundaryHour`** local time (default
`4`). The scheduler uses the agent-day boundary, not the calendar day,
so a post-midnight install does not run two morning routines back-to-back.
There is no separate `morningRoutineHour` — the morning routine and the
agent-day rollover are the same instant.

There is no separate "initial" process key. The first morning after
setup is detected inline by Stage A from the absence of `yesterday.md`;
the daemon injects a `<roadmap_skeleton>` block carrying the pre-aggregated
Annual Goals / Quarterly Focus / Preparation Timeline facts so Stage A
can populate the wizard's placeholder roadmap on medium tier instead of
paying for a one-shot heavy session. (Pre-Phase 7, this branch dispatched
under `routine.morning_routine_initial` on the heavy tier.)

## What It Outputs

- A rebuilt `today.md` with sections for User Schedule, Tasks, Agent Plan, Agent Log, and Handoff.
- A per-date `daily/YYYY-MM-DD.md` capturing the day's calendar snapshot.
- A short notification ("Good morning, here's today...") when notifications are enabled and quiet hours have ended.
- An entry in the Activity feed.

## Where in the Dashboard

- **Schedule view** — the column for today is rebuilt against the new schedule file.
- **Activity feed** — a `routine.morning_routine` row appears at the run timestamp.
- **Settings → Models** — the routine's backend, model, max-turns, and budget cap are configured here.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `dayBoundaryHour` | `4` | Both the agent-day boundary and the morning-routine fire time. See [Agent Day](../../concepts/agent-day.md). |
| Stage A tier (`routine.morning_routine_today`) | medium (Sonnet 4.6) | Synthesises `today.md` + the day's roadmap fan-out. Adjustable per-row in Settings → Models. |
| Stage B tier (`routine.morning_routine_journal`) | lite (Haiku 4.5) | Appends yesterday's entry to `agent-journal.md`. |
| Max turns | 50 | Stage A default. Adjustable per-process in Settings → Models. |
| Max budget USD | 2.00 (Stage A: 0.50, Stage B: 0.10) | Per-execute envelope cap. The router enforces this before token costs accumulate. |

## When Something Goes Wrong

- The most common failure is **morning routine did not run** because the daemon was offline at the trigger window. The next launch picks the run up via the catch-up scheduler if it is still the same agent day.
- A failed morning routine emits a fallback-success notification when the secondary backend caught the run, or a fallback-failed notification (high priority) when both failed.
- Backend quota exhaustion is the second most common cause: a provider rate limit on your `ANTHROPIC_API_KEY`, or — when running on the subscription fallback — the rolling window of the underlying Claude plan. Switch the routine's model in Settings → Models (or wait for the provider window to refresh); if a fallback backend is configured, the router will automatically retry there first.

## Related

- [Agent Day](../../concepts/agent-day.md) — boundary semantics that shift "today".
- [today.md](../memory-files/today.md) — the file the routine rebuilds.
