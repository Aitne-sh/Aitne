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
updated: 2026-06-10
keywords:
  - morning
  - day plan
  - 04:00
  - day boundary
  - two-stage pipeline
  - stage A
  - stage B
  - daily journal
related:
  - concepts/agent-day
  - features/memory-files/today
prerequisites:
  - concepts/agent-day
ui_anchors:
  - /agents/morning-routine
  - /settings/models
  - /schedule
  - /activity
  - /
process_keys:
  - routine.morning_routine
  - routine.morning_routine_today
  - routine.morning_routine_journal
config_keys:
  - dayBoundaryHour
context_files:
  - state/today.md
  - journal/daily/<date>.md
  - journal/agent.md
---

# Morning Routine

## In One Sentence

Once per agent day, at `dayBoundaryHour` local time, Aitne
rebuilds `state/today.md` and the day's schedule from your calendar, mail,
roadmap, and recent observations.

## What It Does

The morning routine is the single highest-value process in Aitne.
It runs as a **two-stage pipeline**, with both stages dispatched in
parallel:

- **Stage A** (`routine.morning_routine_today`, medium tier) rebuilds
  `state/today.md`, walks the roadmap, fans out the day's schedule, and
  self-reports structured metadata.
- **Stage B** (`routine.morning_routine_journal`, lite tier) authors
  yesterday's daily journal at `journal/daily/<yesterday>.md` from a
  daemon-prepared skeleton, then drops the run's audit-trail paragraph
  into `journal/agent.md`.

Every downstream routine for the next 24 hours reads Stage A's output,
so a bad morning briefing degrades the entire day — hence the
medium-tier ceiling on Stage A even after the split.

Within Stage A, the work proceeds in this order:

1. Read the previous day's `state/today.md` and roll forward unfinished items.
2. Pull today's calendar events from any connected calendar integration.
3. Scan recent unread mail and surface the few that need owner attention.
4. Walk the roadmap for items whose **Preparation Timeline** rows fire today.
5. Consume any pending observations the activity scan has already queued.
6. Write the rebuilt `state/today.md`.
7. Log a single status line to the dashboard activity feed.

## When It Runs / How It Is Triggered

The morning routine fires at **`dayBoundaryHour`** local time (default
`4`). The scheduler uses the agent-day boundary, not the calendar day,
so a post-midnight install does not run two morning routines back-to-back.
There is no separate `morningRoutineHour` — the morning routine and the
agent-day rollover are the same instant.

There is no separate "initial" process key. The first morning after
setup is detected inline by Stage A from the absence of `state/yesterday.md`;
the daemon injects a `<roadmap_skeleton>` block carrying the pre-aggregated
Annual Goals / Quarterly Focus / Preparation Timeline facts so Stage A
can populate the wizard's placeholder roadmap on medium tier instead of
paying for a one-shot high-tier session. (The dedicated
`routine.morning_routine_initial` process key — along with its high-tier
seed — was retired in Phase 7, 2026-05-16; the first-run branch now flows
through the parent `routine.morning_routine` envelope.)

## What It Outputs

- A rebuilt `state/today.md` with sections for User Schedule, User Tasks, Agent Plan, Agent Log, and Handoff (Stage A).
- Yesterday's daily journal at `journal/daily/<date>.md` (Stage B).
- A run audit paragraph appended to `journal/agent.md` (Stage B).
- A short morning notification when notifications are enabled and quiet hours have ended.
- An entry in the Activity feed.

## Where in the Dashboard

- **Schedule view** — the column for today is rebuilt against the new schedule file.
- **Activity feed** — a `routine.morning_routine` row appears at the run timestamp.
- **Settings → Models** — the routine's backend, model, max-turns, and budget cap are configured here.
- **Agents → Morning Routine** (`/agents/morning-routine`) — the agent's Rulebook tab edits the morning rulebook (`policies/routines/morning.md`) plus the daily-journal Format and Export rules.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `dayBoundaryHour` | `4` | Both the agent-day boundary and the morning-routine fire time. See [Agent Day](../../concepts/agent-day.md). |
| Stage A tier (`routine.morning_routine_today`) | medium (Sonnet 4.6) | Synthesises `state/today.md` + the day's roadmap fan-out. Adjustable per-row in Settings → Models. |
| Stage B tier (`routine.morning_routine_journal`) | lite (Haiku 4.5) | Authors `journal/daily/<date>.md` and the `journal/agent.md` audit paragraph. |
| Stage A max turns / budget | 50 turns / $1.50 | Per-execute envelope for `routine.morning_routine_today`. Adjustable in Settings → Models. |
| Stage B max turns / budget | 20 turns / $0.30 | Per-execute envelope for `routine.morning_routine_journal`. |

The parent `routine.morning_routine` key keeps its own envelope (50 turns / $2.00) for the pipeline entry point. Codex and Gemini backends scale the dollar caps by a per-tier factor (lite ×2.5, medium ×1.5); the router enforces the cap before token costs accumulate.

## When Something Goes Wrong

- The most common failure is **morning routine did not run** because the daemon was offline at the trigger window. The next launch picks the run up via the boot-time catch-up scheduler if it is still the same agent day (a stale or missing `state/today.md` triggers an inline catch-up run).
- If Stage A runs but fails to produce a valid `state/today.md`, the daemon schedules retries with exponential back-off (5 → 10 → 15 minutes, max 3 attempts) via the `agent_schedule` path, so the retry survives daemon restarts. After the third failure it sends a single **critical** notification asking you to regenerate from the dashboard, and stops retrying. (Stage B is not re-fired on retry — only Stage A regen fixes `state/today.md`.)
- Backend quota exhaustion is the second most common cause: a provider rate limit, or — when running on the subscription fallback — the rolling window of the underlying Claude plan. The router surfaces this as a `BackendQuotaError` and automatically retries on the configured fallback backend first; switch the routine's model in Settings → Models or wait for the provider window to refresh.

## Related

- [Agent Day](../../concepts/agent-day.md) — boundary semantics that shift "today".
- [today.md](../memory-files/today.md) — the file the routine rebuilds.
