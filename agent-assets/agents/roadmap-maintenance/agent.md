---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: roadmap-maintenance
name: Roadmap Maintenance
description: "Mechanical (no-LLM) roadmap.md upkeep — stale-item pruning and section reconciliation — before the evening review."
kind: builtin
version: 1
enabled: true
tags: [routine, daily, roadmap, no-llm]

# ── Schedule (17:45 — releases the roadmap write-lock before Evening Review) ─
schedule:
  kind: cron
  expression: "45 17 * * *"

# ── Backend / routing ────────────────────────────────────────────────────────
# `process_key: null` — this is a no-LLM in-process pass with no backend-routing
# key (§5.5.1). Reserved for built-ins; the schema rejects a null key for user
# Agents.
backend:
  process_key: null
  tier: null
  model: null

# ── Limits (no LLM turn — zero budget; `max_turns` must be ≥ 1 per schema) ──
limits:
  max_turns: 1
  max_budget_usd: 0
  timeout_minutes: 5

# ── Expected outputs ─────────────────────────────────────────────────────────
outputs:
  - plans/roadmap.md

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: high
  services_lost:
    - "Mechanical roadmap.md maintenance (stale-item pruning, section reconciliation)"
  dependent_agents:
    - evening-review
  reactivation_hint: "Re-enable from /agents/roadmap-maintenance. Runs daily at 17:45, before Evening Review."
---

# Roadmap Maintenance

No-LLM in-process pass — there is no task-flow. Implemented by the daemon
callback `onRoadmapMaintenance` registered in `scheduler.ts` (mechanical
`roadmap.md` stale-item pruning and section reconciliation). It runs at 17:45
and releases the roadmap write-lock before Evening Review's 18:00 promotion.
