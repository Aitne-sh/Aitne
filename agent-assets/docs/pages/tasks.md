---
schema_version: 1
slug: pages/tasks
title: "Tasks Page"
id: page-tasks
aliases:
  - tasks page
  - task board
  - queue page
  - schedule page
category: pages
summary: |
  The Tasks page is the operations hub — everything the agent has in
  motion. A standing Board of work items, a run Queue (upcoming and
  history), and your recurring Scheduled DMs, all in your timezone.
tags:
  - agents
  - scheduler
status: stable
ask_examples:
  - What can I do on the Tasks page?
  - Where do I see what the agent is about to run?
  - How do I set up a recurring DM reminder?
  - Where did the Schedule page go?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - tasks
  - queue
  - schedule
  - scheduled dms
  - board
related:
  - pages/agents
  - features/memory-files/schedule
  - features/operations/schedule-approaching
  - concepts/routines
ui_anchors:
  - /tasks
---

# Tasks Page

The `/tasks` page is where the standing work, the run queue, and your
scheduled DMs all live. (The old **Schedule** page merged in here — its
queue and DM rules are now the Queue and Scheduled DMs tabs.)

## What you can do here

- **Board tab** — the read-only Unified Task Board: a live inventory of
  everything in motion (agents, triggers, runs, background workers), each
  clickable for detail.
- **Queue tab** — the concrete runs your schedules produce. **Upcoming**
  lists what is about to run, soonest first; **History** shows what already ran.
- **Scheduled DMs tab** — the home for recurring DM rules (the reminders
  and nudges). Create, edit, and remove them here.
- **Status strip** at the top shows the next scheduled run.

All times render in your own timezone.

## Where to go deeper

- [The schedule memory file](../features/memory-files/schedule.md) — how
  scheduled work is stored.
- [Schedule approaching](../features/operations/schedule-approaching.md) —
  the heads-up the agent gives before a run.
- [Routines](../concepts/routines.md) — the recurring agents that feed the
  queue.

## Related

- [Agents page](agents.md) — the identities behind the runs.
- [Overview page](overview.md) — the next run also shows on the home status bar.
