---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: context-index-reconcile
name: Context Index Reconcile
description: "Mechanical (no-LLM) context-vault index reconciliation shortly before the day boundary, ahead of the morning routine."
kind: builtin
version: 1
enabled: true
tags: [routine, daily, index, no-llm]

# ── Schedule ─────────────────────────────────────────────────────────────────
# `{dayBoundaryHour-1}` resolves to the hour before the day boundary
# (default 4 → "45 3 * * *"), i.e. 15 min before Morning Routine at 04:00.
schedule:
  kind: cron
  expression: "45 {dayBoundaryHour-1} * * *"

# ── Backend / routing (no-LLM in-process pass — null routing key, §5.5.1) ───
backend:
  process_key: null
  tier: null
  model: null

# ── Limits (no LLM turn — zero budget; `max_turns` must be ≥ 1 per schema) ──
limits:
  max_turns: 1
  max_budget_usd: 0
  timeout_minutes: 5

# ── Expected outputs (the reconciler-merged vault index) ────────────────────
outputs:
  - _index.md

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: high
  services_lost:
    - "Context-vault index reconciliation before the morning routine"
  dependent_agents:
    - morning-routine
  reactivation_hint: "Re-enable from /agents/context-index-reconcile. Runs 15 min before the day boundary."
---

# Context Index Reconcile

No-LLM in-process pass — there is no task-flow. Implemented by the daemon
callback `onContextIndexReconcile` registered in `scheduler.ts`; it reconciles
the merged vault index (`_index.md`). It runs 15 min before the day boundary so
the index is fresh when the morning routine reads it, and defers if a retrying
morning routine holds the lock.
