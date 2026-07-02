---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: lesson-maintenance
name: Lesson Maintenance
description: "Mechanical (no-LLM) lesson-store upkeep — confidence (cf) re-stamping and the graduated demote/archive/re-promote lifecycle — before the evening review."
kind: builtin
version: 1
enabled: true
tags: [routine, daily, lessons, feedback, no-llm]

# ── Schedule (17:40 — before the 17:45 roadmap pass and 18:00 Evening Review) ─
schedule:
  kind: cron
  expression: "40 17 * * *"

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
  - policies/agent-lessons.md

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: normal
  services_lost:
    - "Mechanical lesson-store maintenance (confidence re-stamping, graduated demote/archive/re-promote lifecycle)"
  dependent_agents:
    - evening-review
  reactivation_hint: "Re-enable from /agents/lesson-maintenance. Runs daily at 17:40, before Evening Review."
---

# Lesson Maintenance

No-LLM in-process pass — there is no task-flow. Implemented by the daemon
callback `onLessonMaintenance` registered in `scheduler.ts`
(SELF_IMPROVEMENT_PHASE2 §2.1/§2.3): re-stamps each lesson's numeric
confidence (`cf=`) and enacts the graduated demote → archive → re-promote
lifecycle over `policies/agent-lessons.md` and every
`policies/agents/<slug>/lessons.md`, so expiration fires even on nights with
zero feedback signals and hand-edited files re-normalize. It runs at 17:40 so
the 18:00 Evening Review consolidation reads freshly-normalized stores.
