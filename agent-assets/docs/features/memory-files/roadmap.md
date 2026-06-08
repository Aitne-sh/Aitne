---
schema_version: 1
slug: features/memory-files/roadmap
title: roadmap.md
id: roadmap
aliases:
  - roadmap
  - long term goals
  - preparation timeline
category: features
summary: |
  roadmap.md captures long-running goals plus Preparation Timeline
  rows that fire on specific days. The morning routine walks the
  roadmap each day to surface items whose offsets fire.
section: memory-files
tags:
  - memory
  - core
status: stable
ask_examples:
  - What is the roadmap file?
  - What is a Preparation Timeline?
  - How does the morning routine use the roadmap?
  - How do I add a roadmap entry?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - roadmap.md
  - roadmap
  - long-term goals
  - preparation timeline
  - milestones
related:
  - features/routines/morning-routine
  - features/memory-files/projects
  - features/memory-files/today
ui_anchors:
  - /knowledge?tab=context-files
api_endpoints:
  - PUT /api/context/*
  - PATCH /api/context/*
context_files:
  - plans/roadmap.md
---

# roadmap.md

## In One Sentence

A multi-week plan: each goal carries dates and Preparation Timeline
rows that the morning routine fires on the day they come due.

## What It Does

- Captures long-running goals that span more than a single day, so
  they don't fall out of `state/today.md` (which is replaced fresh
  each morning).
- Preparation Timeline rows like "2026-06-13 [notify]: book hotel"
  surface in the morning routine on the day each row is dated (or once
  it is overdue) — turning a far-off milestone into concrete actions at
  the right moment.
- Cross-links to project files for deeper context.

## What It Looks Like

A goal with a Preparation Timeline is just Markdown the agent reads
each morning. For example:

```markdown
### 2026-06-20: Conference talk

Goal: deliver the keynote in Tokyo.

**Preparation Timeline:**
- 2026-06-06 [today]: finalize slide deck
- 2026-06-13 [notify]: book hotel
- 2026-06-18 [today]: dry run with the team
- 2026-06-20 [today]: travel day
```

Each Preparation Timeline row carries an absolute date and a tag
(`[notify]`, `[today]`, `[check]`, or `[schedule]`). On 2026-06-06 the
morning routine sees the `2026-06-06` row come due and pulls "finalize
slide deck" into that day's plan; on 2026-06-13 it surfaces "book
hotel", and so on.

## When It Runs / How It Is Triggered

Read by the morning routine each day, which walks the roadmap and
surfaces any Preparation Timeline rows dated for that day (or overdue).
The file is updated by the operator, or by the agent on request (for
example via the roadmap skill or `aitne run-now roadmap_maintenance`).

The agent never edits the file directly. All writes go through the
daemon's context endpoint — `PUT /api/context/plans/roadmap` (full
replace) or `PATCH /api/context/plans/roadmap` (section op) — which is
guarded by an exclusive roadmap write lock so two flows can't clobber
each other.

## Where in the Dashboard

- **Knowledge → Context Files → roadmap.md**.

## Related

- [Morning Routine](../../routines/morning-routine.md) — reads the roadmap each day.
- [Projects](projects.md) — deeper, per-project context the roadmap links to.
- [today.md](today.md) — the single-day plan the roadmap feeds into.
