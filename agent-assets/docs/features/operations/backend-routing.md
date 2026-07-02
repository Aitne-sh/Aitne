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
updated: 2026-07-01
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

Every job carries a ProcessKey (a label saying what kind of work it is).
The router turns that key into a `(main, fallback)` backend pair plus a
tier — and if the main backend runs out of quota or hits a decisive
failure, the dispatcher switches to the fallback partway through the run,
then DMs you that it happened.

## How It Resolves a Backend

The router never picks a model on its own. The dispatcher hands it a
ProcessKey, and `BackendRouter` works out the binding in this order:

1. Check the `process_backend_config` table for a per-key override
   (`main_backend` / `main_model` / `fallback_backend` / `fallback_model`).
2. If there is no override, use the ProcessKey's **default tier** (a
   size band: `lite` → Haiku-class, `medium` → Sonnet-class, `high` →
   Opus-class) and the backend seeded for that tier.
3. `dashboard.docs_qa` is **tier-locked to `medium`** — pinning it in the
   dashboard can't move it.

Only one ProcessKey — `delegated_task_heavy` — defaults to the `high`
tier, and it is opt-in (turned on by the `delegatedTaskHeavyEnabled`
flag). Nothing you get at install time defaults to Opus.

## What Happens on Failover

Two signals trigger a failover: `BackendQuotaError` (the backend hit a
usage or budget limit) and `BackendDecisiveFailure` (an auth failure,
an unavailable model, a policy-denied request, a timeout, or a
turn-limit). When the main backend raises either one:

- The router **rebuilds the working directory** for the fallback
  backend — writing that backend's instruction file (`AGENTS.md` for
  Codex, `GEMINI.md` for Gemini, and so on) and its skill set into the
  shared folder. Skip this step and a Claude → Codex failover would find
  only `CLAUDE.md` and `.claude/skills/`, so the fallback would run
  blind.
- The fallback then runs with the same prompt and any per-session tool
  overrides that applied to the main run.
- If it succeeds, you get a **low-priority DM** noting that the main
  backend failed and the fallback served the turn.
- If the fallback *also* fails, you get a higher-priority notification:
  `Backend execution failed: <key> encountered <kind> on <main>, then
  <kind> on <fallback>.` This usually means a credentials problem on both
  sides.

## Where in the Dashboard

- **[Settings → Models](/settings/models)** is the one place to pick the
  main and fallback backend (and tier) for each ProcessKey.
- **[Activity](/activity)** rows show which backend actually served each
  turn once fallback was resolved, so you can spot when a failover fired.

## When Something Goes Wrong

- **A `Backend execution failed` notification** means both the main and
  the fallback rejected the run. Check authentication for both backends
  first, and re-authorize from the dashboard if needed.
- **A routine ran on the "wrong" backend** is usually a failover: the
  main backend was over quota, so the fallback served it. The Activity
  row confirms which backend ran.

## Related

- [Backends and Tiers](../../concepts/backends-and-tiers.md)
- [Process Keys](../../concepts/process-keys.md)
- [Cost Tracking](./cost-tracking.md)
