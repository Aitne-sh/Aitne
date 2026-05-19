---
schema_version: 1
slug: reference/config
title: Config Reference
id: config-ref
aliases:
  - config
  - AgentConfig
  - settings keys
  - runtime config
category: reference
summary: |
  All AgentConfig fields, their types, and where each is set
  (environment, database settings table, or in-process default).
section: config
tags:
  - core
  - reference
  - config
  - operations
status: stable
ask_examples:
  - What configuration keys does the agent expose?
  - Where does config get loaded from?
  - How do I change the day boundary?
  - Which config keys are runtime-editable from the dashboard?
locale: en-US
keywords:
  - AgentConfig
  - applyConfigUpdates
  - dayBoundaryHour
  - hourlyCheckIntervalMinutes
  - quietHoursStart
  - quietHoursEnd
  - executeTimeoutMinutes
  - autonomousDailyCostCapUsd
  - allowedToolsOverride
  - PA_DATA_DIR
  - PA_API_PORT
created: 2026-04-25
updated: 2026-05-15
related:
  - reference/api
  - reference/cli-commands
---

# Config Reference

The full schema is `AgentConfig` in `packages/daemon/src/config.ts`.
A subset listed in `applyConfigUpdates` is mutable at runtime via
`PATCH /api/config`. The rest must be set via env or restart.

## Selected Keys

| Key | Type | Default |
|---|---|---|
| `timezone` | IANA tz | `""` (falls back to system tz, e.g. `America/New_York`) |
| `dayBoundaryHour` | 0–23 | `4` |
| `hourlyCheckEnabled` | boolean | `true` |
| `hourlyCheckIntervalMinutes` | number | `60` |
| `hourlyCheckActiveStartHour` | 0–23 | `4` |
| `hourlyCheckActiveEndHour` | 1–24 | `24` (end-exclusive; `24` ≡ midnight) |
| `hourlyCheckMinObservations` | number | `1` |
| `quietHoursStart` | `HH:MM` string | `"22:00"` |
| `quietHoursEnd` | `HH:MM` string | `"08:00"` |
| `maxNotificationsPerHour` | number | `3` |
| `maxNotificationsPerDay` | number | `12` |
| `batchIntervalMinutes` | number | `15` |
| `executeTimeoutMinutes` | number | `60` |
| `maxConcurrentSessions` | number | `3` |
| `disallowedTools` | string[] | absolute-block defaults |
| `allowedToolsOverride` | string[] | empty |
| `autonomousDailyCostCapUsd` | number | `0` (off) |
| `hourlyCheckPrePassFreshnessMinutes` | number | freshness window for the hourly_check `harvestForGate` pre-pass (Layer 1) — skips per-integration fetch if `runtime_state.pre_pass_last_run:<key>` is fresher than this |
| `monthlyReviewEnabled` | boolean | `false` (kill switch — routine.monthly_review stays registered but does not fire by default) |
| `delegatedTaskHeavyEnabled` | boolean | `false` (Approve-tier opt-in — gates `delegated_task_heavy` ProcessKey) |
| `voiceTranscriptionEnabled` | boolean | `false` (Whisper local transcription for voice attachments) |
| `voiceTranscriptionPrimaryLanguage` | string | Whisper language code (see VOICE_LANGUAGE_FULL list) |
| `claudeExecutionPermissionMode` | `"safe"`/`"allow"` | per-backend Safe/Allow posture set in the setup wizard |
| `codexExecutionPermissionMode` | `"safe"`/`"allow"` | same; absolute-block layer overlays both modes |
| `geminiExecutionPermissionMode` | `"safe"`/`"allow"` | same |
| `opencodeExecutionPermissionMode` | `"safe"`/`"allow"` | per-backend mode for the OpenCode backend |
| `opencodeBaseUrl` | URL string | OpenCode server URL (when self-hosted) |
| `opencodeServerUsername` | string | OpenCode server username, default `"opencode"` |

The runtime-mutable subset can be edited from `/settings/*`. Restart-only
fields (e.g. `apiPort`) require `aitne restart`.

### Routine schedule keys do not exist

Morning, evening, and weekly routines fire at fixed times in
`packages/daemon/src/core/scheduler.ts`. There is no `morningRoutineHour`,
`eveningReviewHour`, or `weeklyReviewDay` config key.

| Routine | Trigger |
|---|---|
| `routine.morning_routine` | daily at `dayBoundaryHour` |
| `routine.evening_review` | daily at `18:00` local |
| `routine.weekly_review` | Friday `18:00` local |

Only the hourly check has a configurable cadence (`hourlyCheckIntervalMinutes`)
and an active window (`hourlyCheckActiveStartHour` / `…ActiveEndHour`).

## Related

- [API](api.md)
