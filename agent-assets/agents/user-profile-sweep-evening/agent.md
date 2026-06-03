---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: user-profile-sweep-evening
name: User Profile Sweep (Evening)
description: "Refreshes identity/profile.md from the day's DM traffic shortly before the evening review."
kind: builtin
version: 1
enabled: true
tags: [routine, profile, sweep, evening]

# ── Schedule (17:50 — 10 min before Evening Review at 18:00) ────────────────
schedule:
  kind: cron
  expression: "50 17 * * *"

# ── Backend / routing (tier/model deferred to process_backend_config) ───────
backend:
  process_key: routine.user_profile_sweep
  tier: null
  model: null

# ── Limits (per execution; minimal-tools background pass) ───────────────────
limits:
  max_turns: 15
  max_budget_usd: 0.20
  timeout_minutes: 8

# ── Expected outputs ─────────────────────────────────────────────────────────
outputs:
  - identity/profile.md
  - "identity/<topic>.md"

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: normal
  services_lost:
    - "Pre-evening user/profile.md refresh from the day's DM traffic"
  dependent_agents:
    - evening-review
  reactivation_hint: "Re-enable from /agents/user-profile-sweep-evening. Runs 10 min before Evening Review."
---

# User Profile Sweep (Evening)

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.user_profile_sweep.md` (phase: evening).
