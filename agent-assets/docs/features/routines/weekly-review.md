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
status: stable
ask_examples:
  - When does the weekly review run?
  - What does the weekly retro look at?
  - Where do weekly retros get stored?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
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
  - /agents/weekly-review
context_files:
  - journal/weekly/YYYY-Www.md
  - journal/agent.md
---

# Weekly Review

## In One Sentence

Every Friday evening, a medium-tier weekly retrospective (a look back
over the week) runs and writes a summary into
`journal/weekly/YYYY-Www.md` — one file per ISO week (the standard
Mon–Sun week numbering). Its **Carry Over / Next Week Focus /
Lessons** sections are then copied into every morning routine of the
following ISO week.

## What It Does

- Reads each `journal/daily/YYYY-MM-DD.md` for the current ISO week,
  the week's calendar retrospective, the roadmap, and active projects.
- Pulls this together along three lines — Outcomes, Forward items,
  and Behavioral Lessons — and writes the summary you read.
- Adds a private, agent-only block to `journal/agent.md` covering
  self-critique, filter quality, and improvement ideas.
- Feeds the learning loop: for each concrete, actionable improvement
  idea it finds, it also posts a `source=self_critique` feedback
  signal (on top of the `journal/agent.md` note), so the idea gets
  folded into the [agent lessons](../memory-files/agent-lessons.md)
  instead of only living in the journal.
- Reviews the daemon's self-tuning suggestions: when the weekly
  pre-step spots a cost setting worth changing (for example, widening
  the mail pre-pass freshness window because most fetches came back
  empty), it puts forward up to three bounded proposals, and the
  review records an apply / reject / defer verdict for each. While
  `selfTuningEnabled` is `false` (the default), nothing changes
  automatically — the verdicts are only recorded for the owner to
  review (this is called shadow mode). With the flag on, an apply
  verdict takes effect immediately, kept inside hard per-key limits;
  the owner gets a one-line DM for each applied change
  (`!revert tuning` undoes the most recent one), and a daily monitor
  automatically rolls back any change whose 7-day follow-up metrics
  got worse.
- Sends a short Friday-evening notification by default. It stays quiet
  (the silence gate) only when the week was essentially blank.
- Refreshes `identity/reading-taste.md` and your Book Candidates once
  enough new highlights have piled up.

## When It Runs / How It Is Triggered

It runs every **Friday at 19:00 local time**, one hour after
`evening_review`. The schedule is fixed in
`packages/daemon/src/core/scheduler.ts` and can't be changed. If the
Friday run is missed (say, the daemon was down), the **Fri / Sat / Sun
catch-up window** in `schedule-helpers.ts` runs the retro as soon as
the daemon recovers, before the new ISO week begins. A Mon–Thu
catch-up is left out on purpose, so the next week's `<previous_week>`
injection stays a stable Mon–Sun.

## What It Outputs

- One file per week under `~/.personal-agent/context/journal/weekly/YYYY-Www.md`
  (zero-padded ISO week, e.g. `2026-W19.md`).
- A `## Weekly YYYY-Www` block appended to
  `~/.personal-agent/context/journal/agent.md`.

## Configuration

The run time (Friday 19:00 local) and the day of the week are fixed in
code and can't be changed. What you *can* change is the backend and
model behind this routine: `routine.weekly_review` is a configurable
process key (default **medium** tier — Sonnet on Claude) that you can
repoint from **Settings → Models**. The weekly rulebook
(`policies/routines/weekly.md`) is edited on the weekly-review agent's
Rulebook tab (`/agents/weekly-review?tab=rulebook`), where you can also
enable or disable the agent.

## When Something Goes Wrong

- The retro **doesn't run on Friday**: the Fri–Sun catch-up window
  retries on the Saturday and Sunday agent-days (the agent's own day,
  which rolls over at `dayBoundaryHour` rather than at midnight). If
  the daemon is down for the whole Fri–Sun window, the weekly file is
  never written, and the next week's morning routines simply carry on
  without the `<previous_week>` block.
- The retro **runs but the file is empty** (the silence gate): this is
  fine for a genuinely blank week — the file is still written, just
  with empty sections, and the next week's morning routine sees
  `(none recorded)` sub-blocks. That is the intended signal, not a bug.

## Related

- [Evening Review](evening-review.md)
