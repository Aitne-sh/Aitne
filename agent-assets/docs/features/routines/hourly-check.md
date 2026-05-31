---
schema_version: 1
slug: features/routines/hourly-check
title: Hourly Check
id: hourly-check
aliases:
  - hourly
  - observation consumer
  - hourly check gate
category: features
summary: |
  A medium-tier routine that fires every hour during active hours,
  drains the pending observations queue, and decides whether the
  accumulated change pattern warrants surfacing. Runs through a
  four-layer gate that keeps quiet days quiet.
section: routines
tags:
  - routines
  - autonomous
  - observations
  - polling
  - hourly-check
status: stable
ui_anchors:
  - /settings/routines
  - /settings/schedule
  - /activity?tab=system
ask_examples:
  - What does the hourly check do?
  - When does it run?
  - How does the hourly check decide whether to escalate?
  - What is the harvest pre-pass?
  - How do I tune the gate's freshness window?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - hourly
  - observations
  - polling
  - hourly check
  - gate
  - layer 1
  - layer 2
  - layer 3
  - harvestForGate
  - decideStage
  - pre-pass
related:
  - concepts/observations
  - concepts/routines
  - concepts/delegated-mode
  - features/integrations/browser-history
process_keys:
  - routine.hourly_check
  - routine.hourly_check.triage
  - routine.fetch_window
config_keys:
  - hourlyCheckEnabled
  - hourlyCheckIntervalMinutes
  - hourlyCheckActiveStartHour
  - hourlyCheckActiveEndHour
  - hourlyCheckMinObservations
  - hourlyCheckStage2Enabled
  - hourlyCheckHeartbeatHours
  - hourlyCheckLowSignalPendingCeiling
  - hourlyCheckPrePassFreshnessMinutes
---

# Hourly Check

A medium-tier routine that drains the observations queue every hour
during active hours and decides whether the accumulated change
pattern warrants notifying you or appending to `state/today.md`. The
"decide" step is a four-layer gate designed to keep quiet days quiet
without missing the moment when something piles up.

## When It Runs

Every `hourlyCheckIntervalMinutes` (default 60), inside the active
window `[hourlyCheckActiveStartHour, hourlyCheckActiveEndHour)`. The
trigger:

- **Skips** when the morning routine has not yet run today
  (recoverable — the dispatcher enqueues a `queueMorningRoutineWake`
  self-recovery and the hourly check resumes after the morning
  routine succeeds).
- **Skips** when another hourly check is in flight (atomic flag).
- **Skips** when accumulated signal is below
  `hourlyCheckMinObservations` and the heartbeat window
  (`hourlyCheckHeartbeatHours`) hasn't elapsed.

Every tick writes one `agent_actions` row with
`action_type = 'hourly_check.gate'` so the gate's decisions are
auditable from `aitne audit` and the dashboard activity feed.

## The Four-Layer Gate

The gate replaced the pre-Phase-9 "30-minute rate-limit" gate. It
runs on every cron tick; only Layer 4 actually spawns a medium-tier
agent session.

### Layer 1 — Harvest pre-pass

`HourlyCheckCoordinator.harvestForGate` spawns a lite-tier
`routine.fetch_window` session for each delegated / native
integration whose `runtime_state.pre_pass_last_run:<key>` is older
than `hourlyCheckPrePassFreshnessMinutes`. The pre-pass fetches the
integration's hourly window (mail / calendar / Notion) and POSTs the
results to `/api/observations`, so the rest of the gate sees a
populated queue instead of stale data.

Telemetry: `agent_actions.detail.harvest_ran` /
`harvest_integrations` / `harvest_failed_integrations`.

### Layer 2 — Signal compute

`computeHourlyCheckSignals` reads the observation table mode-blind —
it filters by source-prefix sets derived from
`INTEGRATION_DESCRIPTORS`, never by `actor`. Signal categories
include unread-mail / event-change / repo-change / browser-history
clusters; each category produces a (count, last-seen, summary)
tuple. The pre-pass freshness gate from Layer 1 is what guarantees
those counts reflect "now", not "an hour ago".

### Layer 3 — Decide stage

`decideStage` is a pure function over the signal snapshot plus the
per-tick config (heartbeat status, `hourlyCheckStage2Enabled`,
`hourlyCheckLowSignalPendingCeiling`). It returns one of three stages
— `stage0_silent`, `stage2`, or `stage3`:

| Stage | What happens |
|---|---|
| `stage0_silent` | No agent session. Consume the pending observations and append a single best-effort line to `state/today.md`'s `## Agent Log`. This is the verdict for both "no signals" and "low signal under the ceiling". |
| `stage2` | Only reachable when `hourlyCheckStage2Enabled = true` (default `false`, so low-signal ticks fall through to `stage3`). Runs a lite-tier `routine.hourly_check.triage` call whose strict JSON output decides `log_only` (→ silent path) vs. `escalate` (→ `stage3`). |
| `stage3` | Spawn the full medium-tier `routine.hourly_check` session — the visible agent run. Reached directly on high-novelty signals (VIP mail, calendar conflict, overdue agent plan, approaching schedule) or as the cautious default when Stage 2 is off. |

When a Layer 1 pre-pass fails (`harvest.failed`), the gate
short-circuits to a cautious `stage3` with reason
`cautious_escalate_prepass_failure` and tags the audit row
`agent_actions.detail.cautious_escalate = true` — a failed fetch
should never silently swallow a tick's worth of signals.

### Layer 4 — Dispatch

When Layer 3 returns `stage0_silent` (or Stage 2 returns
`log_only`), the daemon runs `runSilentHourlyCheckPath` — a
daemon-direct write, no agent. When it returns `stage3` (or Stage 2
returns `escalate`), `enqueueStage3HourlyCheck` puts a
`routine.hourly_check` event on the bus, which becomes the visible
agent session.

## What It Outputs

- A best-effort line in `state/today.md`'s `## Agent Log` — even the
  silent path appends one (skipped only if `today.md` is missing or
  the write lock is held; the observations are still consumed either
  way).
- Notifications when warranted (only on a `stage3` agent session).
- An audit row on every tick:
  `agent_actions.action_type = 'hourly_check.gate'`, carrying the
  harvest + signal + stage detail.

## Configuration

| Setting | Default | Layer | Notes |
|---|---|---|---|
| `hourlyCheckEnabled` | `true` | trigger | Master kill switch. |
| `hourlyCheckIntervalMinutes` | `60` | trigger | Cron cadence. |
| `hourlyCheckActiveStartHour` | `4` | trigger | Active window start. |
| `hourlyCheckActiveEndHour` | `24` | trigger | End-exclusive; `24` ≡ midnight. |
| `hourlyCheckMinObservations` | `1` | trigger | Minimum pending observations before a non-silent stage dispatches; below this the tick records a `below_threshold` skip. |
| `hourlyCheckPrePassFreshnessMinutes` | `30` | Layer 1 | Range `0`–`240`. Skip a per-integration fetch if its pre-pass ran more recently; `0` fetches every tick, `240` is cost-minimal. |
| `hourlyCheckStage2Enabled` | `false` | Layer 3 | Adds the lite-tier triage call; while `false`, low-signal ticks route straight to `stage3`. |
| `hourlyCheckHeartbeatHours` | `4` | Layer 3 | Range `1`–`48`. Force a non-silent stage at least this often, even on a quiet day. |
| `hourlyCheckLowSignalPendingCeiling` | `0` | Layer 3 | Range `0`–`20`. At or below this pending count, a low-signal tick stays silent. `0` keeps the cautious default (any pending observation escalates). |

(`hourlyCheckGateMode` was removed in HOURLY_CHECK_GATE_REDESIGN_PLAN
Phase 4 — the gate has a single execution path now.)

## When Something Goes Wrong

- **Skipped because the morning routine hasn't run.** The
  dispatcher's `morningRoutineRanToday` gate keys on
  `agent_actions.result = 'success'`. The skip reason is
  `morning_routine_pending_for_today` and triggers a
  `queueMorningRoutineWake` self-recovery. See
  [Morning Routine Didn't Run](../../troubleshooting/morning-routine-didnt-run.md).
- **Stage 3 never fires on a quiet day.** Expected.
  `hourlyCheckHeartbeatHours` forces a tick occasionally so silence
  doesn't last indefinitely.
- **Pre-pass keeps failing for one integration.** Read
  `agent_actions.detail.harvest_failed_integrations`; the failing
  integration name is recorded. Usually an auth issue — check
  `/health.integrationModes` and the integration's settings page.

## Related

- [Observations](../../concepts/observations.md) — what populates the
  queue Layer 2 reads.
- [Delegated Mode](../../concepts/delegated-mode.md) — the
  delegated / native integrations that participate in Layer 1's
  harvest.
- [Routines](../../concepts/routines.md)
