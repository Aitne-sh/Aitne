---
schema_version: 1
slug: features/memory-files/agent-lessons
title: agent lessons
id: agent-lessons
aliases:
  - lessons
  - agent lessons
  - feedback learning loop
  - policies/agent-lessons.md
category: features
summary: |
  The agent's learned-behavior stores — a global policies/agent-lessons.md
  plus a per-agent policies/agents/<slug>/lessons.md. Your corrections and
  preferences, the agent's own self-critiques, and your reactions are
  captured as feedback signals, consolidated nightly into dated lessons,
  re-generalized monthly, and injected back into the right executions.
section: memory-files
tags:
  - memory
  - feedback
  - learning
  - routines
status: beta
ask_examples:
  - What are the agent lessons?
  - Where does the agent remember my corrections?
  - How does the feedback learning loop work?
  - What is a provisional lesson?
  - How do I tune the lesson caps?
locale: en-US
created: 2026-06-08
updated: 2026-06-07
keywords:
  - lessons
  - feedback
  - learning loop
  - corrections
  - preferences
  - self-critique
  - provisional
related:
  - features/routines/evening-review
  - features/routines/weekly-review
  - features/memory-files/agent-journal
  - reference/knowledge-layout
process_keys:
  - routine.evening_review
  - routine.weekly_review
  - routine.monthly_review
context_files:
  - policies/agent-lessons.md
  - policies/agents/<slug>/lessons.md
ui_anchors:
  - /settings/lessons
---

# agent lessons

## In one sentence

The lesson stores are where the agent remembers how you want it to
behave: a short, dated list of learned directives that grows from your
corrections and the agent's own retros, and is fed back into the agent's
work so it stops repeating the same mistakes.

## What they are

There are two kinds of store:

- **Global agent behavior** — `policies/agent-lessons.md`. Lessons that
  apply to the agent as a whole. These are injected into your DM
  conversations and into the routines that decide whether to notify you.
- **Per-agent** — `policies/agents/<slug>/lessons.md`, one per Agent
  Definition. These are injected **only** into that agent's own
  executions, so a lesson learned for your "weekly-report" agent never
  leaks into an unrelated one.

Both live under `~/.personal-agent/context/policies/`, alongside your
other rule files, and are plain Markdown you can read or hand-edit.

Each store is a `## Lessons` section of dated bullets. A lesson looks
like:

```
- [2026-06-07] Keep the budget section in the weekly report. <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->
```

The trailing HTML comment is bookkeeping the daemon manages: how much
evidence backs the lesson (`ev`), what kind it is (a `correction`, a
`do-more`/`do-less`, a hard `constraint`, …), how it was sourced, and
when it was last reinforced. You can ignore the comment when reading —
the prose before it is the directive.

## How a lesson is born

You never write these files to teach the agent a lesson; the loop does
it for you. There are three ways signals enter:

- **You correct it or state a preference.** When, in a DM, you correct
  the agent, tell it how you want something done, or say
  stop / do-more / do-less, it records that once as a feedback signal.
  This does **not** change the current reply — your correction already
  lives in that conversation — but it is remembered for later.
- **The agent critiques itself.** The [weekly](../routines/weekly-review.md)
  and monthly reviews post each concrete, actionable improvement idea as
  a `self_critique` signal.
- **Your reactions.** Whether you replied to or ignored a proactive
  message is recorded as a weaker signal.

Those raw signals don't become lessons immediately. Each night the
[evening review](../routines/evening-review.md) folds the day's
unconsumed signals into the right store as dated lessons, then marks them
consumed (it skips the step entirely when nothing pends). Once a month
the monthly review — off by default; opt in by enabling the
monthly-review agent at `/agents/monthly-review` — runs a re-generalize
pass that collapses several same-theme lessons into one higher-level
principle, keeping each store small.

## Provisional vs. active

A new lesson is stored but is not necessarily *injected* right away. A
lesson carries a `<!-- provisional -->` marker until it has enough
corroborating evidence; provisional lessons sit in the file but are not
fed into the agent's prompts. This avoids over-fitting to a single
offhand comment.

How a lesson crosses from provisional to active:

- A behavioral or self-critique lesson must reach weighted evidence at or
  above the **promotion threshold** (`feedbackPromotionThreshold`,
  default 2). Evidence is weighted by source — an explicit or corrected
  signal counts 1.0, a reply or self-critique 0.5, an ignore 0.25.
- An **explicit owner directive** ("always do X", "stop doing Y")
  promotes on the first occurrence — it is taken at your word.
- An **ignore on its own never promotes** a lesson, and is never read as
  disapproval.

## Bounded by design

The stores can't grow without limit. Each is capped in bytes and entry
count — the global store at `feedbackLessonMaxBytesGlobal` bytes
(default 8192) / 40 entries, the per-agent stores at
`feedbackLessonMaxBytesPerAgent` (default 4096) / 20 entries. When a
store is full, the lowest-signal lessons are dropped first. Lessons that
go untouched for `feedbackLessonStaleDays` (default 60) are pruned — with
one exception: a `kind=constraint` lesson is durable and is never
stale-pruned or collapsed away. The underlying feedback signals
themselves are retained for `feedbackSignalRetentionDays` (default 180).

## Where in the dashboard

**Settings → Lessons** (`/settings/lessons`, labelled "Lessons" with a
**Preview** badge) is the read/tune surface. From there you can view and
edit the lessons themselves and adjust every knob above:
`feedbackLearningEnabled` (the master kill-switch, on by default),
`feedbackPromotionThreshold`, the byte caps, the stale-days horizon, and
the signal retention window. Turning `feedbackLearningEnabled` off stops
both capture and consolidation.

## Configuration

All of the loop's knobs are listed above and live on the Lessons page;
there is nothing to configure in the files themselves. Because the stores
are plain Markdown, **you** can hand-edit, prune, or remove a lesson at
any time — the loop will pick up from whatever it finds the next night.

## Related

- [Evening Review](../routines/evening-review.md) — folds the day's
  feedback signals into these stores each night.
- [Weekly Review](../routines/weekly-review.md) — posts self-critique
  signals that feed the loop. The optional (off-by-default) monthly
  review re-generalizes the stores once a month.
- [agent journal](agent-journal.md) — the reflection-shaped diary, a
  separate file from these directive stores.
- [Knowledge layout](../../reference/knowledge-layout.md) — where the
  `policies/` stores sit in the wider context vault.
