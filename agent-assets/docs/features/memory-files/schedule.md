---
schema_version: 1
slug: features/memory-files/schedule
title: journal/daily/ files
id: schedule-files
aliases:
  - daily journal
  - daily directory
  - per-date journal
  - journal/daily/YYYY-MM-DD.md
  - schedule directory
category: features
summary: |
  Per-date diary files (journal/daily/YYYY-MM-DD.md) the morning
  routine writes as a first-person retrospective of the previous
  agent-day. They are a read-only archive composed by the daemon from
  the Stage B journal session's output; weekly and monthly reviews
  read them back.
section: memory-files
tags:
  - memory
  - journal
  - routines
  - core
status: stable
ask_examples:
  - Where does the agent store the day's diary?
  - What is in journal/daily and how is it different from today.md?
  - How do I change which sections the daily journal includes?
locale: en-US
created: 2026-04-25
updated: 2026-06-10
keywords:
  - daily journal
  - diary
  - per-date
  - retrospective
  - synthesis
related:
  - features/routines/morning-routine
  - features/memory-files/today
  - features/memory-files/agent-journal
  - concepts/agent-day
ui_anchors:
  - /tasks
  - /agents/morning-routine?tab=rulebook
process_keys:
  - routine.morning_routine_journal
context_files:
  - journal/daily/<date>.md
---

# journal/daily/ Files

## In One Sentence

`journal/daily/YYYY-MM-DD.md` is the morning routine's first-person
diary of the **previous** agent-day — what the user did, who they met,
what they talked about — composed by the daemon and kept as a
read-only archive that the weekly and monthly reviews read back.

> **Renamed from `schedule/`.** The old mechanical `schedule/YYYY-MM-DD.md`
> copy was retired. Today the morning routine synthesizes a diary at
> `journal/daily/YYYY-MM-DD.md` instead — a retrospective, not a plan.
> Pruning any leftover `schedule/` directory is safe.

## What It Is (and What It Is Not)

This is a **diary of what already happened**, written for the user in
their own voice. It is the opposite end of the day from
[today.md](today.md):

- **`state/today.md`** is the live, forward-looking plan for the
  *current* agent-day — calendar events ahead, items to prepare,
  carryover.
- **`journal/daily/<date>.md`** is the finished, retrospective record
  of a *past* agent-day. Once written it is not rewritten.

It is also distinct from [journal/agent.md](agent-journal.md): the
daily journal is the *user's* diary, while `journal/agent.md` is the
agent's own decision log. Agent-side telemetry (action counts, retry
stats) never appears here.

## What It Contains

Each file under `~/.personal-agent/context/journal/daily/` corresponds
to one **agent day** (the file name uses the agent-day date, not the
calendar date — see [Agent Day](../../concepts/agent-day.md)). The body
typically includes:

- `## Summary` — a first-person recap of the day.
- `## Schedule` — the events and meetings that actually took place.
- `## Tasks` — what the user worked on.
- `## Conversations` — who they talked to and about what.

When the `browser_history` integration is active, a reading/research
surface is woven in from the day's browser digest. Daemon-owned
frontmatter (`date`, `weekday`, `calendar_events`, `messages_handled`,
`projects`, `people`, `tags`, `content_hash`, `updated`) is filled in
automatically. The exact sections and tone are governed by the
journal-format and journal-export policy files (see
[Configuration](#configuration)).

## When It Runs / How It Is Written

The daily journal is **Stage B of the 04:00 morning routine**
(process key `routine.morning_routine_journal`, lite tier), which runs
in parallel with Stage A's `state/today.md` rollover. Stage B authors
the body of *yesterday's* file; because the agent has no write tools,
its output is two XML-tagged blocks that the daemon's
`DailyJournalComposer` extracts, frames with frontmatter, and writes
atomically to disk.

Because the synthesis reads pre-aggregated facts captured at rotation
time, late edits made directly to `state/today.md` after rollover
cannot retroactively rewrite an already-written `journal/daily/` file.

Other routines (weekly and monthly reviews) read these files back but
do not rewrite them.

## Where in the Dashboard

The daily journal does **not** appear on the Schedule page — that page
shows the scheduler's wake-ups and recurring routines, not these files.

- **The morning-routine agent's Rulebook tab
  (`/agents/morning-routine?tab=rulebook`)** is where you shape the
  output: the Format and Export rule files control which sections
  appear, the voice, the required frontmatter, and the redaction /
  inclusion rules applied on every synthesis run. Edits take effect on
  the next morning routine.

## Configuration

There is nothing to configure on the files themselves; they are a
side effect of the morning routine. To change *what* gets written, edit
the journal Format and Export rules on the morning-routine agent's
Rulebook tab (`/agents/morning-routine?tab=rulebook`).

Retention is unlimited — old files accumulate. A manual prune
(`rm ~/.personal-agent/context/journal/daily/2025-*.md`) is safe.

## When Something Goes Wrong

- A **missing or empty** daily file usually means the morning routine
  did not run. See
  [Morning Routine Didn't Run](../../troubleshooting/morning-routine-didnt-run.md).
- An entry **dated to the wrong day** is the day-boundary subtlety:
  before `dayBoundaryHour` (default 04:00 local), the agent day is
  still yesterday. See [Agent Day](../../concepts/agent-day.md).

## Related

- [Morning Routine](../routines/morning-routine.md) — the writer (Stage B).
- [today.md](today.md) — the live, forward-looking plan for the
  current agent-day.
- [journal/agent.md](agent-journal.md) — the agent's own decision log,
  distinct from this user diary.
