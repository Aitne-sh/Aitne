---
schema_version: 1
slug: features/routines/weekly-review
title: Weekly Review
id: weekly-review
aliases:
  - weekly retro
  - sunday review
category: features
summary: |
  Once a week, the agent reads the past seven days of journal
  entries, completed tasks, and roadmap progress, then writes a
  weekly retro into the weekly/ directory.
section: routines
tags:
  - routines
  - autonomous
  - light-tier
status: stable
ask_examples:
  - When does the weekly review run?
  - What does the weekly retro look at?
  - Where do weekly retros get stored?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - weekly review
  - Friday review
  - week roll-up
  - agent week
related:
  - concepts/routines
  - features/memory-files/agent-journal
process_keys:
  - routine.weekly_review
---

# Weekly Review

## In One Sentence

A light-tier weekly retro fires once per week and writes a synthesis
into `weekly/YYYY-Www.md` (ISO week), whose **Carry Over / Next Week
Focus / Lessons** sections are then lifted into every morning routine
of the following ISO week.

## What It Does

- Reads daily files for the current ISO week, the past-7-day calendar
  retrospective, roadmap, and active projects.
- Synthesizes three axes — Outcomes, Forward items, Behavioral
  Lessons — and writes the user-facing snapshot.
- Appends an agent-internal block to `journal/agent.md` for self-
  critique, filter quality, and improvement ideas.
- Sends a brief Friday-evening notification by default (silence gate
  triggers only on an essentially blank week).
- Refreshes `user/reading-taste.md` and Book Candidates when enough
  new highlights have accumulated.

## When It Runs / How It Is Triggered

Every **Friday at 19:00 local time** (one hour after `evening_review`).
The schedule is fixed in `packages/daemon/src/core/scheduler.ts` and is
not operator-configurable. If the Friday fire misses (daemon outage),
the **Fri / Sat / Sun catch-up window** in `schedule-helpers.ts` fires
the retro when the daemon recovers, before the new ISO week begins —
a Mon–Thu catch-up is intentionally out of scope so the next week's
`<previous_week>` injection stays stable Mon–Sun.

## What It Outputs

- One file per week under `~/.personal-agent/context/weekly/YYYY-Www.md`
  (zero-padded ISO week, e.g. `2026-W19.md`).
- A `## Weekly YYYY-Www` block appended to
  `~/.personal-agent/context/agent/journal.md`.

## Configuration

This routine has no operator-tunable knobs. The fire time, day-of-week,
and tier are fixed in code.

## When Something Goes Wrong

- The retro **doesn't fire on Friday**: the Fri–Sun catch-up window
  retries on Saturday and Sunday agent-days. A full Fri–Sun outage
  results in a missing weekly file; the next week's morning routines
  proceed without the `<previous_week>` block.
- The retro **runs but the file is empty** (silence gate): legitimate
  for a blank week — the file is still written with empty sections,
  and the next week's morning routine sees `(none recorded)` sub-
  blocks, which is the deliberate downstream signal.

## Related

- [Evening Review](evening-review.md)
