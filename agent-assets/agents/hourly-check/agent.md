---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: hourly-check
name: Hourly Check
description: "Triages pending observations and proactively surfaces new mail / calendar / git / notion activity each interval within active hours."
kind: builtin
version: 1
enabled: true
tags: [routine, hourly, observations, proactive]

# ── Schedule ─────────────────────────────────────────────────────────────────
# LOADER-IGNORED PLACEHOLDER. The real cadence is a runtime window built by
# `buildHourlyCronExpr(intervalMinutes, activeStart, activeEnd)` — the registry
# (§5.5) sets `cronExpression: null` and is authoritative, and the loader's
# drift check is a no-op for this slug. The literal below is only the
# self-documenting default window (interval 60min, active 04:00-24:00) needed to
# satisfy the schema's `cron → expression` refinement; the scheduler does NOT
# fire from it.
schedule:
  kind: cron
  expression: "0 4-23 * * *"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.hourly_check
  tier: null
  model: null

# ── Limits (per execution; runs frequently, kept lean) ──────────────────────
limits:
  max_turns: 20
  max_budget_usd: 0.25
  timeout_minutes: 10

# ── Expected outputs ─────────────────────────────────────────────────────────
# Surfacing is conditional (only when pending observations clear the gate), so
# there is no deterministic per-run vault write to assert as a criterion.
outputs:
  - "DM surfacing of new mail / calendar / git / notion activity (conditional)"
  - journal/agent.md

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: high
  services_lost:
    - "Hourly observation triage"
    - "Proactive surfacing of new mail / calendar / git / notion activity"
  dependent_agents: []
  reactivation_hint: "Re-enable from /agents/hourly-check. Resumes on the next interval tick within active hours."
---

# Hourly Check

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.hourly_check.md` (and the delegated triage
flow `agent-assets/task-flows/routine.hourly_check.triage.md`).

The firing cadence is a runtime window owned by `buildHourlyCronExpr` in
`scheduler.ts`, not the `schedule.expression` above; the scheduler also gates
firing on `config.hourlyCheckEnabled`.
