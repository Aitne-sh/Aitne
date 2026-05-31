---
schema_version: 1
slug: features/operations/backend-routing
title: Backend Routing
id: backend-routing
aliases:
  - router
  - main fallback
  - failover
category: features
summary: |
  BackendRouter resolves each ProcessKey to a (main, fallback) backend
  pair and a tier. On BackendQuotaError or BackendDecisiveFailure, the
  main backend's session fails over to the fallback's mid-run.
section: operations
tags:
  - core
  - operations
  - backends
  - routing
status: stable
ask_examples:
  - What happens when my Claude quota is exhausted?
  - Why did my routine run on Codex when I picked Claude?
  - How do fallbacks work?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - backend routing
  - BackendRouter
  - fallback
  - main fallback
  - BackendQuotaError
  - BackendDecisiveFailure
  - process_backend_config
process_keys:
  - message.dm
  - agent.task
  - delegated_task_heavy
ui_anchors:
  - /settings/models
  - /activity
api_endpoints:
  - GET /api/process-config
  - PUT /api/process-config/:processKey
  - PUT /api/backends/main
related:
  - concepts/backends-and-tiers
  - concepts/process-keys
  - features/operations/cost-tracking
---

# Backend Routing

## In One Sentence

Every job carries a ProcessKey. The router resolves that key to a
`(main, fallback)` backend pair plus a tier — and if the main backend
hits a quota wall or a decisive failure, the dispatcher transitions to
the fallback mid-run, then DMs you that it happened.

## How It Resolves a Backend

The router never picks a model itself. The dispatcher hands it a
ProcessKey, and `BackendRouter` resolves the binding in this order:

1. Read the `process_backend_config` table for a per-key override
   (`main_backend` / `main_model` / `fallback_backend` / `fallback_model`).
2. If no override exists, fall back to the ProcessKey's **default tier**
   (`lite` → Haiku-class, `medium` → Sonnet-class, `high` → Opus-class)
   and the seeded backend for that tier.
3. `dashboard.docs_qa` is **tier-locked to `medium`** — an operator pin
   can't move it.

Only one ProcessKey — `delegated_task_heavy` — defaults to the `high`
tier, and it is opt-in (gated by the `delegatedTaskHeavyEnabled` flag).
No install-time surface defaults to Opus.

## What Happens on Failover

The two failover signals are `BackendQuotaError` (the backend hit a
usage/budget limit) and `BackendDecisiveFailure` (auth failure, model
unavailable, policy-denied, timeout, or turn-limit). When the main
backend raises either:

- The router **re-materializes the session workdir** for the fallback
  backend — writing its instruction file (`AGENTS.md` for Codex,
  `GEMINI.md` for Gemini, etc.) and skill set into the shared dir. Without
  this step a Claude → Codex fallover would leave only `CLAUDE.md` and
  `.claude/skills/`, and the fallback would run blind.
- The fallback then executes with the same prompt and any
  per-session tool overrides applied to the main run.
- On success, you get a **low-priority DM** noting the main backend
  failed and the fallback served the turn.
- If the fallback *also* fails, you get a higher-priority notification:
  `Backend execution failed: <key> encountered <kind> on <main>, then
  <kind> on <fallback>.` This is usually a credentials problem on both
  sides.

## Where in the Dashboard

- **[Settings → Models](/settings/models)** is the unified surface for
  picking the main and fallback backend (and tier) per ProcessKey.
- **[Activity](/activity)** rows show which backend actually served each
  turn after fallback resolution, so you can see when a fallover fired.

## When Something Goes Wrong

- **A `Backend execution failed` notification** means both the main and
  the fallback rejected the run. Check authentication for both backends
  first — re-authorize from the dashboard if needed.
- **A routine ran on the "wrong" backend** is usually a fallover: the
  main backend was over quota, so the fallback served it. The Activity
  row will confirm which backend ran.

## Related

- [Backends and Tiers](../../concepts/backends-and-tiers.md)
- [Process Keys](../../concepts/process-keys.md)
- [Cost Tracking](./cost-tracking.md)
