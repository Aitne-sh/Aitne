---
schema_version: 1
slug: features/routines/evening-review
title: Evening Review
id: evening-review
aliases:
  - evening routine
  - end of day
  - retro
category: features
summary: |
  The evening review fires once per day at 18:00 local time. It closes out
  the day by finalizing today.md's Handoff, doing light roadmap maintenance,
  and folding the day's profile signals into your identity files. It rolls
  up unfinished items so tomorrow's morning routine can re-pick them up.
section: routines
tags:
  - routines
  - autonomous
status: stable
ask_examples:
  - When does the evening review run?
  - What does the evening review write?
  - How do I add my own evening checks?
  - How do I disable the evening review?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - evening review
  - retro
  - end of day
  - handoff
  - carry-over
related:
  - concepts/routines
  - features/memory-files/agent-journal
  - features/memory-files/today
  - features/routines/morning-routine
  - guides/add-a-custom-routine
process_keys:
  - routine.evening_review
context_files:
  - state/today.md
  - plans/roadmap.md
  - journal/agent.md
  - identity/profile.md
  - policies/routines/evening.md
  - policies/agent-lessons.md
ui_anchors:
  - /knowledge?tab=context-files
  - /agents/evening-review
---

# Evening Review

## In One Sentence

A medium-tier autonomous routine that fires daily at 18:00 local time to
close out the day: it finalizes the carry-over plan in `state/today.md`,
does light roadmap maintenance, and folds the day's profile signals into
your identity files.

## What It Does

The routine runs several internal bookkeeping steps. These are quiet by
design — they prepare state that **tomorrow's morning routine depends on**
rather than producing a chatty end-of-day report.

1. **Finalize `state/today.md`.** Marks incomplete User Tasks, then fills
   the `## Handoff` section: unfinished items roll into **Tomorrow** (with
   a reason and suggested priority) so the morning routine re-picks them up;
   longer-horizon items go to **Later**.
2. **Light roadmap maintenance.** Promotes resolved Long-term Plans into the
   Agent Action Plan and fires any plans whose review date has arrived,
   editing only `## Long-term Plans` and `## Agent Action Plan` in
   `plans/roadmap.md`. (The purely mechanical roadmap sweeps run 15 minutes
   earlier as a separate daemon job, not here.)
3. **Process profile signals.** Reads the day's Raw Signals from your
   profile and routes each into `character`, Learned Context, or a
   detailed identity file under `identity/`, then prunes stale entries.
4. **Consolidate feedback signals into lessons.** When feedback learning is
   on (default) and signals are pending, folds the day's unconsumed feedback
   into the scoped lesson stores (`policies/agent-lessons.md` for agent-scope
   lessons; identity files for owner directives), then marks them consumed.
   Skipped entirely when no signals pend.

## When It Runs / How It Is Triggered

Every day at **18:00 local time**, exactly once. The schedule — a cron
expression (`0 18 * * *`, the standard five-field way to write "18:00 every
day") — is fixed in `packages/daemon/src/core/scheduler.ts`, so you can't
change the fire time. Like every autonomous routine, the run is skipped
while the agent is paused (`!stop`) or setup is not finished.

## What It Outputs

- An updated `## Handoff` section in `state/today.md`.
- Roadmap edits in `plans/roadmap.md` when a plan was promoted or fired.
- A `journal/agent.md` line **only** when a roadmap review date fired or a
  validation error needs recording.
- Lesson edits in `policies/agent-lessons.md` when feedback signals were
  pending and consolidated.

The built-in steps emit **no user-facing DM by default** — there is no
"today wraps up here" message. (The one exception: any check you add to
`policies/routines/evening.md` is authoritative and runs as written,
including steps that call `POST /api/notify`.)

## Where in the Dashboard

- **Knowledge → Context Files** (`/knowledge?tab=context-files`) shows
  `journal/agent.md` entries when the roadmap step logged one.
- **Agents → Evening Review** (`/agents/evening-review`) is where you
  manage the evening rulebook (Rulebook tab) and enable or disable the
  routine.

## Configuration

The fire time and tier are fixed in code, but the routine is not a black box:
- **Add your own evening checks.** Append `### <label>` entries to
  `policies/routines/evening.md` (via the dashboard or the context
  API). They run alongside the built-in steps using the same
  journaling conventions and may notify you explicitly. For a
  standalone recurring job on its own schedule, create a
  [recurring Agent](../../guides/add-a-custom-routine.md) instead.
- **Verify it stays healthy.** `aitne verify evening-review-slimdown`
  checks that recent `routine.evening_review` sessions ran inside their
  seeded token envelope (read-only; `--days N` widens the window).

## When Something Goes Wrong

- **The Handoff or journal stops updating:** the routine may be hitting a
  quota wall — see [Quota Exhausted](../../troubleshooting/quota-exhausted.md)
  or [Auth Failed](../../troubleshooting/auth-failed.md).
- **It never fires at all:** confirm the agent is not paused (`!start`) and
  that setup is complete.

## Related

- [today.md](../memory-files/today.md) — where the Handoff lives.
- [agent journal](../memory-files/agent-journal.md) — `journal/agent.md`.
- [morning routine](morning-routine.md) — consumes the Handoff next day.
