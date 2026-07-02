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
  ("morning routine", "DM", "activity scan"). The router resolves it
  to a backend + tier binding; the manifest map resolves it to skills.
section: process-keys
tags:
  - routing
  - backends
status: stable
ask_examples:
  - What is a ProcessKey?
  - Where can I see all the ProcessKeys?
  - How do I change which model handles a ProcessKey?
  - What is the difference between configurable and fixed ProcessKeys?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - process key
  - ProcessKey
  - dispatch
  - routing
  - tier
  - CONFIGURABLE_PROCESS_KEYS
  - DEFAULT_PROCESS_TIERS
  - REACTIVE_PROCESS_KEYS
  - TIER_LOCKED_PROCESS_KEYS
  - PROCESS_TO_EVENT_TYPE
  - routine.morning_routine
  - message.dm
  - dashboard.chat
related:
  - concepts/backends-and-tiers
  - concepts/skills
  - reference/process-keys
  - features/operations/backend-routing
process_keys:
  - routine.morning_routine
  - routine.morning_routine_today
  - routine.morning_routine_journal
  - routine.evening_review
  - routine.activity_scan
  - routine.fetch_window
  - routine.activity_scan.triage
  - message.dm
  - message.mention
  - dashboard.chat
  - dashboard.docs_qa
  - agent.task
  - agent.dm_task
  - delegated_task
  - delegated_task_heavy
ui_anchors:
  - /settings/models
---

# ProcessKeys

## TL;DR

A ProcessKey is a short string like `routine.morning_routine` or
`message.dm` that names one class of agent work. Every routine, every
event the agent reacts to, and every dashboard action carries one. The
router uses it to pick the backend; the skills compiler uses it to pick
the tools.

## Why This Concept Exists

Without a stable name for each class of task, "the morning routine" and
"a DM" would have to be told apart by hand everywhere they behave
differently — pricing, retention, tool scope, and auditing. The
ProcessKey is the one label that connects dispatch to all of those
subsystems.

## Definitions

- **CONFIGURABLE_PROCESS_KEYS**: the keys an operator can override per
  backend on `/settings/models`. The rest (`delegated_task`, `setup`,
  `schedule.approaching`, …) use fixed defaults and do not appear
  there.
- **REACTIVE_PROCESS_KEYS**: keys tied to events that happen while you
  interact with the agent (`message.dm`, `message.mention`,
  `dashboard.chat`, `dashboard.docs_qa`, `setup`, `knowledge.import`).
  Everything else runs on its own (autonomous).
- **DEFAULT_PROCESS_TIERS**: the default model size for each key —
  `lite` (Haiku-class), `medium` (Sonnet-class), or `high`
  (Opus-class). Unknown keys default to `medium`.
- **TIER_LOCKED_PROCESS_KEYS**: keys whose tier is hard-locked, so an
  operator pin cannot change it. Today this is just `dashboard.docs_qa`,
  locked to `medium`.
- **PROCESS_TO_EVENT_TYPE**: maps a ProcessKey to its skill manifest
  key, so the skills compiler can pick the right tool set.

## Concrete Examples

- **Routines:** `routine.morning_routine` is the parent envelope read by
  the pre-routine gate; the actual work runs as two parallel split keys
  — `routine.morning_routine_today` (Stage A, today.md, medium) and
  `routine.morning_routine_journal` (Stage B, daily journal, lite). Also
  `routine.evening_review`, `routine.weekly_review`,
  `routine.activity_scan`, `routine.roadmap_refresh`,
  `routine.today_refresh`, `routine.user_profile_sweep`.
  `routine.morning_routine_initial` was retired (2026-05-16) — the
  first-run branch now routes through `routine.morning_routine`.
- **Routine sub-jobs** (lite tier, dispatcher-spawned, not user-facing):
  `routine.fetch_window` (pre-pass mail/calendar/Notion fetcher that
  runs before each main routine and POSTs observations) and
  `routine.activity_scan.triage` (Stage 2 escalate-vs-log-only gate
  inside the activity scan).
- **Custom routines (retired):** `routine.custom.<slug>` appears only
  in historical Activity rows — operator-defined recurring work now
  runs as user Agents under `agent.task`.
- **Messaging:** `message.dm`, `message.mention`
- **Dashboard:** `dashboard.chat`, `dashboard.docs_qa`
- **Scheduled / external:** `agent.task` (recurring schedules),
  `agent.dm_task` (DM-tone scheduled briefings),
  `schedule.approaching`, `calendar.change`, `gmail_classify`, `setup`
- **Delegated work:** `delegated_task` (lite) and `delegated_task_heavy`
  — the only high-tier key, opt-in via the `delegatedTaskHeavyEnabled`
  config flag. No install-time surface defaults to `high`; operators
  pin high per-row on `/settings/models`.

## Where You See It in the Dashboard

- **Settings → Models** lists every configurable ProcessKey with its
  current binding.
- **Activity** rows include the ProcessKey for every fire.

## Related

- [Backends and Tiers](backends-and-tiers.md)
- [Skills](skills.md)
- [Reference: ProcessKeys](../reference/process-keys.md)
