---
schema_version: 1
slug: concepts/process-keys
title: ProcessKeys
id: process-keys
aliases:
  - process key
  - dispatch key
  - event key
category: concepts
summary: |
  A ProcessKey is the agent's dispatch identity for one kind of work
  ("morning routine", "DM", "hourly check"). The router resolves it
  to a backend + tier binding; the manifest map resolves it to skills.
section: process-keys
tags:
  - core
  - dispatch
  - backends
  - routing
status: stable
ask_examples:
  - What is a ProcessKey?
  - Where can I see all the ProcessKeys?
  - How do I change which model handles a ProcessKey?
  - What is the difference between configurable and fixed ProcessKeys?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
keywords:
  - process key
  - ProcessKey
  - dispatch
  - routing
  - CONFIGURABLE_PROCESS_KEYS
  - DEFAULT_PROCESS_TIERS
  - PROCESS_TO_EVENT_TYPE
  - routine.morning_routine
  - message.dm
  - dashboard.chat
related:
  - concepts/backends-and-tiers
  - concepts/skills
  - reference/process-keys
---

# ProcessKeys

## TL;DR

A ProcessKey is a string like `routine.morning_routine` or `message.dm`
that identifies one class of agent work. Every routine, every reactive
event, every dashboard action is tagged with one. The router uses it
to pick the backend; the skills compiler uses it to pick the tools.

## Why This Concept Exists

Without a stable identifier per task class, "the morning routine" and
"a DM" would have to be hand-distinguished everywhere they were
treated differently — pricing, retention, tool scope, auditability.
The ProcessKey is the single coupling that ties dispatch to all of
those subsystems.

## Definitions

- **CONFIGURABLE_PROCESS_KEYS**: the set the operator can override per
  backend on `/settings/models`.
- **REACTIVE_PROCESS_KEYS**: those tied to in-the-loop events (DMs,
  dashboard chat, docs QA).
- **DEFAULT_PROCESS_TIERS**: the per-key default (`lite`, `medium`, or
  `high`).
- **PROCESS_TO_EVENT_TYPE**: maps a ProcessKey to the skill manifest
  key.

## Concrete Examples

- Routines: `routine.morning_routine` (parent envelope read by the
  pre-routine gate, plus the Phase 5 split keys
  `routine.morning_routine_today` and `routine.morning_routine_journal`),
  `routine.evening_review`, `routine.weekly_review`,
  `routine.hourly_check`,
  `routine.roadmap_refresh`, `routine.today_refresh`,
  `routine.user_profile_sweep`. `routine.morning_routine_initial` was
  retired by morning-routine-optimization.md Phase 7 (2026-05-16) — the
  first-run branch routes through `routine.morning_routine`.
- Routine sub-jobs (lite tier, dispatcher-spawned, not user-facing):
  `routine.fetch_window` (pre-pass mail/calendar/Notion fetcher that
  runs before each main routine and POSTs observations) and
  `routine.hourly_check.triage` (Stage 2 escalate-vs-log-only gate
  inside the hourly check).
- Custom routines: `routine.custom.<slug>` (kebab-case slug)
- Messaging: `message.dm`, `message.mention`
- Dashboard: `dashboard.chat`, `dashboard.docs_qa`
- Scheduled / external: `agent.task` (recurring schedules),
  `agent.dm_task` (DM-tone scheduled briefings),
  `schedule.approaching`, `calendar.change`, `gmail_classify`,
  `setup`

## Where You See It in the Dashboard

- **Settings → Models** lists every configurable ProcessKey with its
  current binding.
- **Activity** rows include the ProcessKey for every fire.

## Related

- [Backends and Tiers](backends-and-tiers.md)
- [Skills](skills.md)
- [Reference: ProcessKeys](../reference/process-keys.md)
