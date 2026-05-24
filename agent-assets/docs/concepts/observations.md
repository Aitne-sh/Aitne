---
schema_version: 1
slug: concepts/observations
title: Observations
id: observations
aliases:
  - observation
  - polling
  - hourly check
  - observation queue
  - phase 9
category: concepts
summary: |
  Observations are change records the polling integrations write into
  SQLite. The hourly check consumes them — there is no per-change
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
  - How does the hourly check use observations?
  - Where does the routine pre-pass write observations?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
keywords:
  - observation
  - observations
  - polling
  - hourly check
  - phase 9
  - routine.fetch_window
  - pre-pass
  - AgentWriteTracker
  - contentHash
related:
  - features/routines/hourly-check
  - features/routines/morning-routine
  - concepts/process-keys
  - concepts/routines
ui_anchors:
  - /activity
config_keys:
  - hourlyCheckIntervalMinutes
  - hourlyCheckPrePassFreshnessMinutes
---

# Observations

## TL;DR

Polling integrations (Obsidian, Git, Notion, Calendar) **do not emit
events** when they detect changes. They write observation rows to
SQLite. A single `routine.hourly_check` consumes the queue and decides
what is worth surfacing.

Since 2026-05, observations have a **second writer**: every main
routine (morning, today_refresh, hourly_check, evening, weekly) is
preceded by a lite-tier `routine.fetch_window` pre-pass that fetches
mail / calendar / Notion windows and POSTs them to
`/api/observations`. The main routine then reads them via the same
`pending=true` queue that the polling path feeds. Observation rows
look identical regardless of which writer produced them — the
distinction is invisible to downstream consumers.

## Why This Concept Exists

Per-change notifications turned every routine commit, every saved
note, every tiny calendar tweak into a paging event. The Phase 9
pivot moved the agent away from that: changes accumulate, and once an
hour the agent looks at the bag and decides whether the pattern adds
up to something the operator should hear about.

## Definitions

- **Observation**: one row in the `observations` table.
- **Actor**: who caused the change. `actor='agent'` rows are filtered
  out by the consumer (anti-loop).
- **Hourly check**: the consumer routine. Medium tier by default
  (Sonnet); fed by both the background polling path and the pre-pass
  fetcher.
- **`AgentWriteTracker`**: the daemon component that tags
  agent-originated writes so observers don't observe the agent's own
  output.
- **Pre-pass writer (2026-05+)**: the lite-tier `routine.fetch_window`
  session spawned by each main routine's dispatcher. Fetches a
  per-routine window (`ROUTINE_WINDOWS` in
  `packages/daemon/src/core/routine-windows.ts`) for each enabled
  mail / calendar / Notion integration and POSTs observations. The
  server computes `contentHash` from `(source, payload)`, so an
  unchanged item written twice in the same cadence dedupes to a 409.

## Concrete Examples

- A new commit in a watched repo → 1 observation.
- A saved note in Obsidian → 1 observation.
- A calendar event move → 1 observation.

## Where You See It in the Dashboard

- **Activity** logs hourly-check fires; the detail shows how many
  observations were consumed.

## Related

- [Hourly Check](../features/routines/hourly-check.md)
- [Git](../features/integrations/git.md)
- [Obsidian](../features/integrations/obsidian.md)
