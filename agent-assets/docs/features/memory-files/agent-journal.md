---
schema_version: 1
slug: features/memory-files/agent-journal
title: journal/agent.md
id: agent-journal
aliases:
  - journal
  - agent journal
  - agent log
category: features
summary: |
  The agent's append-only log of decisions, retros, and judgement
  calls, at journal/agent.md. Distinct from Activity (which is
  action-shaped) — the journal is reflection-shaped. Written by the
  morning, evening, and weekly routines; the API enforces append-only.
section: memory-files
tags:
  - memory
  - journal
  - routines
status: stable
ask_examples:
  - What is the agent journal?
  - Where does the agent log its own decisions?
  - How is the journal different from Activity?
  - Why did journal/agent.md stop growing?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - journal
  - retros
  - decisions
  - reflection
  - append-only
related:
  - features/routines/morning-routine
  - features/routines/evening-review
  - features/routines/weekly-review
  - features/memory-files/agent-lessons
  - features/operations/activity-and-conversations
  - concepts/memory-model
process_keys:
  - routine.morning_routine_today
  - routine.morning_routine_journal
  - routine.evening_review
  - routine.weekly_review
context_files:
  - journal/agent.md
ui_anchors:
  - /knowledge?tab=context-files
  - /agents/morning-routine?tab=rulebook
---

# journal/agent.md

## In one sentence

`journal/agent.md` is the agent's own running diary — what it noticed,
what it tried, what it would do differently — appended (never
rewritten) so a long timeline accumulates.

## What it is

The journal is the place the agent writes about its own work in the
first person. Unlike Activity — which is the action-shaped audit log
of *what happened* — the journal is reflection-shaped: it captures
*why*, *what surprised it*, and *what it would change*.

Each entry carries:

- A dated heading — the morning routine stamps a
  `## YYYY-MM-DD morning routine` H2; the weekly and monthly retros add
  a `> Appended at: YYYY-MM-DD HH:MM` line under their section header.
- A short context line — which routine or conversation prompted it.
- The reflection itself.

The file lives at `~/.personal-agent/context/journal/agent.md`. The
day-to-day morning and ad-hoc entries accumulate indefinitely. A daily
retention rollup then keeps only a rolling window of the structured
retros — the most recent 12 `## Weekly` and 24 `## Monthly` sections —
and prunes older ones. Later routines read the file back to look for
patterns.

## Who writes it, and when

Three routines append to the journal — none ever rewrites it:

- **Morning routine** is the recurring daily writer — and here the
  daemon (the always-on local background service) does the writing
  itself, rather than an AI-model (LLM) stage. Once the day's
  stages (Stage A `routine.morning_routine_today`, Stage B
  `routine.morning_routine_journal`) finish, the daemon appends a
  one-paragraph audit-trail entry built from the run's
  `agent_actions` rows — stage results, inbox stats, anomalies — plus
  a one-line footprint of the prior day's actions. This is the entry
  you'll see most often.
- **Weekly review** (`routine.weekly_review`) appends the largest
  structured block: a `## Weekly YYYY-Www` retro with *What worked*,
  *What slipped on my side*, *System improvement ideas*, and agent-side
  metrics.
- **Evening review** (`routine.evening_review`) appends short
  bookkeeping lines — for example a one-liner each time it bumps a
  roadmap review forward, or a validation error if a roadmap write was
  rejected. It does not write the bulk of the diary.

In-the-moment notes can also land here when the agent flags something
worth recording during reactive work — its live back-and-forth with
you, outside the scheduled routines.

### Example entry

```
## Weekly 2026-W21
> Appended at: 2026-05-25 21:40

### What worked
- Morning brief landed before the 09:00 standup three days running.
### What slipped on my side
- Missed the Friday PR-review trigger — webhook arrived during quiet hours.
### System improvement ideas
- Add Saturday to the Weekend day-type default so weekend pushes triage.
### Metrics (agent side)
- Routine runs (7d): 142 total / 3 failed (prev week: 150 / 5)
- Spend (7d): $4.10 (prev week: $4.80); top cost: routine.fetch_window $2.10
- Notifications (7d): 9 sent / 4 ignored (prev week sent: 11)
```

The metrics lines are copied verbatim from the `<self_performance>`
block the daemon computes and injects into the weekly session — the
review does not count anything itself.

## Append-only — enforced, not just convention

The journal is append-only at the API layer, not merely by prompt
discipline. `journal/agent.md` is the sole entry in `CREATE_ONLY_PUT`:
a `PUT` only succeeds if the file does not yet exist, and a `PATCH`
must use `append` or `append_to_file` mode. A `replace` or `clear`
PATCH is rejected outright, so a misbehaving (or prompt-injected) agent
cannot destroy history. Writes go through the daemon context API
(`PATCH /api/context/journal/agent`) — the agent has no direct
`Edit`/`Write` access to the file.

## Where in the dashboard

- **Knowledge → Context Files** (`/knowledge?tab=context-files`) is the
  read view of the file — `journal/agent` is listed among the top-level
  context files. It is flagged as sensitive: entering edit mode surfaces
  a "deliberately pruning noise" warning before you change anything.
- **The morning-routine agent's Rulebook tab**
  (`/agents/morning-routine?tab=rulebook`)
  does *not* edit this file. It hosts the daily-journal rule files —
  `policies/journal-format.md` (sections, voice, frontmatter) and
  `policies/journal-export.md` (redaction / inclusion rules) — both of
  which the morning routine reads when synthesizing `daily/YYYY-MM-DD.md`,
  not `journal/agent.md`. `/connections/journal` is a compatibility alias
  that redirects here.

## Configuration

There is no per-entry configuration. The file is plain Markdown, so
**you** (the human owner) can hand-edit, prune, or git-version it like
any other context file — the API append-only guard applies only to the
agent's own writes, not to you editing the file on disk.

## When something goes wrong

- **The journal stops growing.** This usually points at the morning
  routine (whose daemon-side appender writes the daily entry) or the
  evening/weekly review not
  running. See [Morning Routine](../routines/morning-routine.md) and
  [Evening Review](../routines/evening-review.md).
- **Entries look duplicated.** This usually means a routine retried
  after a backend fallback. Because writes are append-only, a retry
  re-appends rather than overwrites — the weekly review deliberately
  appends a fresh section instead of editing in place. The daemon's
  daily retention rollup (`rollupAgentJournal`) collapses duplicate
  `## Weekly YYYY-Www` / `## Monthly YYYY-MM` keys last-write-wins
  within 24 hours, so duplicates self-heal; a manual prune is fine but
  rarely needed.

## Related

- [Morning Routine](../routines/morning-routine.md) — the recurring
  daily writer (via the daemon-side appender).
- [Weekly Review](../routines/weekly-review.md) — the largest retro.
- [Evening Review](../routines/evening-review.md) — appends short
  bookkeeping lines.
- [Activity & Conversations](../operations/activity-and-conversations.md)
  — the action-shaped audit log, distinct from the reflection-shaped
  journal.
- [agent lessons](agent-lessons.md) — the directive-shaped learned-behavior
  stores, distinct from this reflection-shaped diary.
- [Memory model](../../concepts/memory-model.md) — how the journal fits
  the wider context vault.
