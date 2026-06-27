---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: activity-scan
name: Activity Scan
description: "Triages pending observations and proactively surfaces new mail / calendar / git / notion activity each interval within active hours."
kind: builtin
version: 1
enabled: true
tags: [routine, periodic, observations, proactive]

# ── Schedule ─────────────────────────────────────────────────────────────────
# LOADER-IGNORED PLACEHOLDER. The real cadence is a runtime window built by
# `buildActivityScanCronExpr(intervalMinutes, activeStart, activeEnd)` — the registry
# (§5.5) sets `cronExpression: null` and is authoritative, and the loader's
# drift check is a no-op for this slug. The literal below is only the
# self-documenting default window (interval 120min, active 04:00-24:00) needed
# to satisfy the schema's `cron → expression` refinement; the scheduler does
# NOT fire from it.
schedule:
  kind: cron
  expression: "0 4-22/2 * * *"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.activity_scan
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
    - "Periodic observation triage"
    - "Proactive surfacing of new mail / calendar / git / notion activity"
  dependent_agents: []
  reactivation_hint: "Re-enable from /agents/activity-scan. Resumes on the next interval tick within active hours."
---

# Activity Scan

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.activity_scan.md` (and the delegated triage
flow `agent-assets/task-flows/routine.activity_scan.triage.md`).

The firing cadence is a runtime window owned by `buildActivityScanCronExpr` in
`scheduler.ts`, not the `schedule.expression` above. The window's values live
on this agent's row (`metadata_json.runtime_window`, edited via
`PATCH /api/agents/activity-scan`), with the `activityScan*` config keys
(formerly `hourlyCheck*` — the agent was named "Hourly Check" until v0.1.11)
as per-field fallback; `agents.enabled` is the single on/off switch
(AGENTS_HUB_REDESIGN_PLAN.md §2). Default cadence: every 2 hours (120 min)
within active hours 04:00–24:00.
