---
schema_version: 1
slug: concepts/observations
title: Observations
id: observations
aliases:
  - observation
  - polling
  - activity scan
  - observation queue
  - phase 9
category: concepts
summary: |
  Observations are change records the polling integrations write into
  SQLite. The activity scan consumes them — there is no per-change
  notification. This pivot was the Phase 9 polling change.
section: observations
tags:
  - core
  - observations
  - polling
  - integrations
  - routines
status: stable
ask_examples:
  - What is an observation?
  - Why doesn't the agent message me on every git commit?
  - How does the activity scan use observations?
  - Where does the routine pre-pass write observations?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - observation
  - observations
  - polling
  - activity scan
  - phase 9
  - routine.fetch_window
  - pre-pass
  - AgentWriteTracker
  - contentHash
  - recordObservation
  - observation queue
  - dedupe
related:
  - features/routines/activity-scan
  - features/routines/morning-routine
  - concepts/process-keys
  - concepts/routines
  - features/integrations/git
  - features/integrations/obsidian
ui_anchors:
  - /activity
process_keys:
  - routine.activity_scan
  - routine.fetch_window
config_keys:
  - activityScanIntervalMinutes
  - activityScanPrePassFreshnessMinutes
api_endpoints:
  - POST /api/observations
  - POST /api/observations/batch
  - GET /api/observations
  - POST /api/observations/consume
context_files:
  - packages/daemon/src/core/routine-windows.ts
  - packages/daemon/src/api/routes/observations.ts
---

# Observations

## TL;DR

Polling integrations (Obsidian, Git, Notion, Calendar) **do not emit
events** when they detect changes. They write observation rows to
SQLite. A single `routine.activity_scan` consumes the queue and decides
what is worth surfacing.

Since 2026-05, observations have a **second writer**: every main
routine (`routine.morning_routine`, `routine.today_refresh`,
`routine.activity_scan`, `routine.evening_review`,
`routine.weekly_review`) is preceded by a lite-tier
`routine.fetch_window` pre-pass that fetches mail / calendar / Notion
windows and POSTs them to `/api/observations/batch`.
(`routine.monthly_review` has no pre-pass window.) The main routine
then reads them via the same `pending=true` queue that the polling
path feeds. Observation rows look identical regardless of which writer
produced them — the distinction is invisible to downstream consumers.

## Why This Concept Exists

Per-change notifications turned every routine commit, every saved
note, every tiny calendar tweak into a paging event. The Phase 9
pivot moved the agent away from that: changes accumulate, and once an
hour the agent looks at the bag and decides whether the pattern adds
up to something the operator should hear about.

## Definitions

**Two writer paths feed one queue.** Observations enter the
`observations` table from two places, and downstream consumers cannot
tell them apart:

1. **Background pollers** (Obsidian, Git, GitHub, Notion, Calendar,
   Mail) call `recordObservation` when they detect a change.
2. **The pre-pass** — the lite-tier `routine.fetch_window` session
   spawned ahead of each main routine — POSTs mail / calendar / Notion
   windows to `/api/observations/batch`.

Both write rows of the same shape; the consumer reads the merged queue.

- **Observation**: one row in the `observations` table.
- **Actor**: who caused the change (`user`, `agent`, or `system`). The
  activity-scan gate filters pending rows by source, not actor —
  pre-pass and delegated-sync rows arrive as `actor='agent'` and count
  as real activity. The anti-loop guard lives at write time instead,
  via `AgentWriteTracker` (below).
- **Activity scan**: the consumer routine. Medium tier by default
  (Sonnet); fed by both the background polling path and the pre-pass
  fetcher.
- **`AgentWriteTracker`**: the daemon component that tags
  agent-originated writes so observers don't observe the agent's own
  output.
- **Pre-pass writer (2026-05+)**: the lite-tier `routine.fetch_window`
  session spawned by each main routine's dispatcher. Fetches a
  per-routine window (`ROUTINE_WINDOWS` in
  `packages/daemon/src/core/routine-windows.ts`) for each enabled
  mail / calendar / Notion integration and POSTs the results to
  `/api/observations/batch`. The server computes `contentHash` from
  `(source, payload)`, so an unchanged item written twice in the same
  cadence dedupes as a `duplicate` instead of writing a second row.

## Concrete Examples

- A new commit in a watched repo → 1 observation.
- A saved note in Obsidian → 1 observation.
- A calendar event move → 1 observation.

## Where You See It in the Dashboard

- **Activity** logs activity-scan fires; the detail shows how many
  observations were consumed.

## Related

- [Activity Scan](../features/routines/activity-scan.md)
- [Morning Routine](../features/routines/morning-routine.md)
- [Process Keys](./process-keys.md)
- [Routines](./routines.md)
- [Git](../features/integrations/git.md)
- [Obsidian](../features/integrations/obsidian.md)
