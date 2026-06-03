---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: skill-curation
name: Skill Curation
description: "Generates typed skill self-optimization proposals on the configured cadence (opt-in)."
kind: builtin
version: 1
enabled: true
tags: [routine, skills, self-learning, opt-in]

# ── Schedule (03:00; scheduler reads the configured cadence at fire time) ────
schedule:
  kind: cron
  expression: "0 3 * * *"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.skill_curation
  tier: null
  model: null

# ── Limits (per execution) ───────────────────────────────────────────────────
limits:
  max_turns: 25
  max_budget_usd: 0.50
  timeout_minutes: 15

# ── Expected outputs ─────────────────────────────────────────────────────────
# Output is typed curation submissions (proposals persisted via the
# skill-curation API), not a deterministic vault file — documented here, no
# post-execute criterion asserted in v1.
outputs:
  - "Typed skill self-optimization proposals (skill-curation submissions)"

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: normal
  services_lost:
    - "Skill self-optimization proposals (typed curation submissions)"
  dependent_agents: []
  reactivation_hint: "Skill curation is opt-in via /settings/self-learning. Re-enable from /agents/skill-curation."
---

# Skill Curation

Built-in routine — opt-in via `/settings/self-learning`. The execution runs in
the optimizer workdir (`dispatcher-scheduled-tasks.ts`, P22 §3.4) against the
`/api/skill-curation/*` surface and the `agent-assets/optimizer-skills/skill-curation`
assets; there is no `task-flows/routine.skill_curation.md`. The scheduler gates
firing on `isSkillCurationEnabled(db)` and the configured cadence.
