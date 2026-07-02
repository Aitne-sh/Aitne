---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: source-librarian
name: Source Librarian
description: "Weekly triage of unfiled source documents into knowledge/sources/ cards, taxonomy upkeep, and library-vault consistency checks."
kind: builtin
version: 1
enabled: true
tags: [routine, weekly, sources, maintenance]

# ── Schedule (Saturday 09:00; scheduler adds a no-LLM nothing-to-do prefilter) ─
schedule:
  kind: cron
  expression: "0 9 * * 6"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.source_maintenance
  tier: null
  model: null

# ── Limits (per execution) ───────────────────────────────────────────────────
limits:
  max_turns: 50
  max_budget_usd: 1.00
  timeout_minutes: 20

# ── Expected outputs ─────────────────────────────────────────────────────────
# Cards are keyed on agent-chosen collection/slug paths, which the
# `{date}`-only success-criteria evaluator cannot target in v1, so they are
# documented here rather than asserted as criteria.
outputs:
  - "knowledge/sources/<collection>/<slug>.md"
  - knowledge/sources/_index.md

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: normal
  services_lost:
    - "Weekly filing of unfiled source documents into knowledge/sources/"
    - "Source library and vault consistency checks"
  dependent_agents: []
  reactivation_hint: "Re-enable from /agents/source-librarian. Resumes on the next Saturday 09:00 firing."
---

# Source Librarian

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.source_maintenance.md`.
