---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: evening-review
name: Evening Review
description: "Appends the evening reflection journal and reconciles the roadmap at end of day."
kind: builtin
version: 1
enabled: true
tags: [routine, daily, roadmap]

# ── Schedule ─────────────────────────────────────────────────────────────────
schedule:
  kind: cron
  expression: "0 18 * * *"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.evening_review
  tier: null
  model: null

# ── Limits (per execution) ───────────────────────────────────────────────────
# Mirrors the runtime envelope (plan-presets / process_backend_config seed:
# routine.evening_review is 50 / $2.00). These values prefill the dashboard
# Definition form; a stale lower number saved there would clamp the real runs
# via override_snapshot, so keep them in step with the seed authority.
limits:
  max_turns: 50
  max_budget_usd: 2.00
  timeout_minutes: 12

# ── Expected outputs ─────────────────────────────────────────────────────────
# Steps 1-3 are internal bookkeeping that Morning Routine depends on and emit
# no user-facing output by default; the deterministic vault write is the
# roadmap reconciliation. None of these are wholesale-regenerated `{date}`
# files, so no post-execute criterion is asserted in v1.
outputs:
  - plans/roadmap.md
  - "state/today.md (tomorrow preparation)"

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: high
  services_lost:
    - "Evening reflection journal append"
    - "End-of-day roadmap reconciliation"
  dependent_agents:
    - weekly-review
  reactivation_hint: "Re-enable from /agents/evening-review. Resumes on the next 18:00 firing."
---

# Evening Review

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.evening_review.md`.
