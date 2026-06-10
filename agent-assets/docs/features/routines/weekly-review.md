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
  Once a week (Friday evening), the agent reads the current ISO
  week's daily journal entries, the week's calendar retrospective,
  and roadmap progress, then writes a weekly retro into
  journal/weekly/YYYY-Www.md. Its Carry Over / Next Week Focus /
  Lessons sections are lifted into every morning routine of the
  following ISO week.
section: routines
tags:
  - routines
  - autonomous
  - journal
  - reflection
status: stable
ask_examples:
  - When does the weekly review run?
  - What does the weekly retro look at?
  - Where do weekly retros get stored?
locale: en-US
created: 2026-04-25
updated: 2026-06-09
keywords:
  - weekly review
  - Friday review
  - week roll-up
  - agent week
  - ISO week
  - next week focus
related:
  - concepts/routines
  - features/routines/evening-review
  - features/memory-files/agent-journal
  - features/memory-files/agent-lessons
process_keys:
  - routine.weekly_review
config_keys:
  - timezone
  - dayBoundaryHour
  - selfTuningEnabled
ui_anchors:
  - /settings/models
  - /settings/routines
context_files:
  - journal/weekly/YYYY-Www.md
  - journal/agent.md
---

# Weekly Review

## In One Sentence

A medium-tier weekly retro fires every Friday evening and writes a
synthesis into `journal/weekly/YYYY-Www.md` (ISO week), whose
**Carry Over / Next Week Focus / Lessons** sections are then lifted
into every morning routine of the following ISO week.

## What It Does

- Reads each `journal/daily/YYYY-MM-DD.md` for the current ISO week,
  the week's calendar retrospective, the roadmap, and active projects.
- Synthesizes three axes — Outcomes, Forward items, Behavioral
  Lessons — and writes the user-facing snapshot.
- Appends an agent-internal block to `journal/agent.md` for
  self-critique, filter quality, and improvement ideas.
- Feeds the learning loop: for each concrete, actionable system
  improvement idea it identifies, it also posts a `source=self_critique`
  feedback signal (in addition to the `journal/agent.md` prose), so the
  idea is consolidated into the [agent lessons](../memory-files/agent-lessons.md)
  rather than only living in the journal.
- Judges the daemon's self-tuning recommendations: when the weekly
  pre-step finds a cost knob worth changing (e.g. raising the mail
  pre-pass freshness window because most fetches came back empty), it
  injects up to three bounded proposals and the review records an
  apply / reject / defer verdict for each. While `selfTuningEnabled` is
  `false` (the default) nothing is ever changed automatically — verdicts
  are recorded for the owner to review (shadow mode). With the flag on,
  an apply verdict is actuated immediately by the daemon within hard
  per-key bounds; the owner gets a one-line DM per applied change
  (`!revert tuning` undoes the latest one) and a daily monitor
  auto-reverts any change whose 7-day follow-up metrics regressed.
- Sends a brief Friday-evening notification by default (the silence
  gate triggers only on an essentially blank week).
- Refreshes `identity/reading-taste.md` and Book Candidates when
  enough new highlights have accumulated.

## When It Runs / How It Is Triggered

Every **Friday at 19:00 local time** (one hour after `evening_review`).
The schedule is fixed in `packages/daemon/src/core/scheduler.ts` and is
not operator-configurable. If the Friday fire misses (daemon outage),
the **Fri / Sat / Sun catch-up window** in `schedule-helpers.ts` fires
the retro when the daemon recovers, before the new ISO week begins —
a Mon–Thu catch-up is intentionally out of scope so the next week's
`<previous_week>` injection stays stable Mon–Sun.

## What It Outputs

- One file per week under `~/.personal-agent/context/journal/weekly/YYYY-Www.md`
  (zero-padded ISO week, e.g. `2026-W19.md`).
- A `## Weekly YYYY-Www` block appended to
  `~/.personal-agent/context/journal/agent.md`.

## Configuration

The fire time (Friday 19:00 local) and day-of-week are fixed in code
and are not operator-tunable. The backend and model that handle this
routine, however, are configurable: `routine.weekly_review` is a
configurable process key (default **medium** tier — Sonnet on Claude)
that you can repoint from **Settings → Models**.

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
