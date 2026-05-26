---
schema_version: 1
slug: features/memory-files/agent-journal
title: agent/journal.md
id: agent-journal
aliases:
  - journal
  - agent journal
  - agent log
category: features
summary: |
  The agent's append-only log of decisions, retros, and judgement
  calls. Distinct from Activity (which is action-shaped) — the journal
  is reflection-shaped.
section: memory-files
tags:
  - memory
  - journal
  - reflection
status: stable
ask_examples:
  - What is the agent journal?
  - Where does the agent log its own decisions?
  - How is the journal different from Activity?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - journal
  - retros
  - decisions
  - reflection
related:
  - features/routines/evening-review
  - features/routines/weekly-review
  - features/operations/activity-and-conversations
ui_anchors:
  - /connections/journal
  - /settings/journal
context_files:
  - agent/journal.md
---

# agent/journal.md

## In One Sentence

`journal/agent.md` is the agent's own running diary — what it noticed,
what it tried, what it would do differently — appended (never
rewritten) so a long timeline accumulates.

## What It Does

The journal is the place the agent writes about its own work in the
first person. Each entry has:

- A timestamp.
- A short context line (which routine / conversation prompted it).
- The reflection itself.

Unlike Activity, the journal is opinion-shaped. The evening review
adds the day's reflections; the weekly retro reads them back to
look for patterns.

## When It Runs / How It Is Triggered

- **Evening review** adds the largest chunk — what worked, what was
  surprising, what felt off.
- **Weekly review** appends a retro that quotes prior journal entries
  to find a thread.
- **In-the-moment** entries fire when the agent notices something
  worth flagging during reactive work.

## What It Outputs

- An ever-growing append-only file at
  `~/.personal-agent/context/agent/journal.md`.
- A linked-from-roadmap section when an entry tied a project to a new
  decision.

## Where in the Dashboard

- **Connections → Journal** is the read view of the file.
- **Settings → Journal** controls retention and which routines
  contribute (currently always-on for evening / weekly).

## Configuration

There is no per-entry configuration. The file is plain Markdown — you
can hand-edit, prune, or git-version it like any other context file.

## When Something Goes Wrong

- A journal that **stops growing** points at the evening review not
  running. See [Evening Review](../policies/routines/evening-review.md).
- A journal that **looks duplicated** usually means a routine retried
  after a fallback. The agent's own anti-duplicate check is best-effort,
  not bulletproof — manual prune is fine.

## Related

- [Evening Review](../policies/routines/evening-review.md) — the daily writer.
- [Weekly Review](../policies/routines/weekly-review.md) — the consumer.
- [Activity](../operations/activity-and-conversations.md) — the
  action-shaped audit log, distinct from the journal.
