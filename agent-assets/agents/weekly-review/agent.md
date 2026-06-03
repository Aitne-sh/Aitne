---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: weekly-review
name: Weekly Review
description: "Writes the weekly synthesis note and reviews the roadmap every Friday evening."
kind: builtin
version: 1
enabled: true
tags: [routine, weekly, journal]

# ── Schedule (Friday 19:00) ──────────────────────────────────────────────────
schedule:
  kind: cron
  expression: "0 19 * * 5"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.weekly_review
  tier: null
  model: null

# ── Limits (per execution) ───────────────────────────────────────────────────
limits:
  max_turns: 30
  max_budget_usd: 0.50
  timeout_minutes: 15

# ── Expected outputs ─────────────────────────────────────────────────────────
# The synthesis note is keyed on the ISO week (`journal/weekly/YYYY-Www.md`),
# which the `{date}`-only success-criteria evaluator cannot target in v1, so it
# is documented here rather than asserted as a criterion.
outputs:
  - "journal/weekly/{week}.md"
  - plans/roadmap.md

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: high
  services_lost:
    - "Weekly synthesis note (journal/weekly/{week}.md)"
    - "Weekly roadmap review"
  dependent_agents: []
  reactivation_hint: "Re-enable from /agents/weekly-review. Resumes on the next Friday 19:00 firing."
---

# Weekly Review

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.weekly_review.md`.
