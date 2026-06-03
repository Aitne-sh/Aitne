---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: monthly-review
name: Monthly Review
description: "Writes the monthly synthesis note and month-end retrospective on the last day of the month (opt-in)."
kind: builtin
version: 1
# OFF by default pre-release (§2.1, frozen). Do not flip without owner sign-off.
# The scheduler additionally gates firing on `config.monthlyReviewEnabled`.
enabled: false
tags: [routine, monthly, journal, opt-in]

# ── Schedule (18:00 + scheduler-side last-day-of-month filter) ──────────────
schedule:
  kind: cron
  expression: "0 18 * * *"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.monthly_review
  tier: null
  model: null

# ── Limits (per execution; the monthly synthesis reads ~30 daily files) ─────
limits:
  max_turns: 40
  max_budget_usd: 1.00
  timeout_minutes: 20

# ── Expected outputs ─────────────────────────────────────────────────────────
# Keyed on the calendar month (`journal/monthly/YYYY-MM.md`); not targetable by
# the `{date}`-only evaluator, so documented here, not asserted as a criterion.
outputs:
  - "journal/monthly/{month}.md"

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: normal
  services_lost:
    - "Monthly synthesis note"
    - "Month-end retrospective"
  dependent_agents: []
  reactivation_hint: "Monthly review is opt-in (monthlyReviewEnabled, default off). Re-enable from /agents/monthly-review."
---

# Monthly Review

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.monthly_review.md`.

Disabled by default pre-release: the scheduler consults
`config.monthlyReviewEnabled` (default `false`) before firing, and this
definition ships `enabled: false`.
