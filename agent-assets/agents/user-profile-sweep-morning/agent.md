---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: user-profile-sweep-morning
name: User Profile Sweep (Morning)
description: "Refreshes identity/profile.md from the day's DM traffic shortly before the day boundary, ahead of the morning routine."
kind: builtin
version: 1
enabled: true
tags: [routine, profile, sweep, morning]

# ── Schedule ─────────────────────────────────────────────────────────────────
# `{dayBoundaryHour-1}` resolves to the hour before the day boundary
# (default 4 → "50 3 * * *"), i.e. 10 min before Morning Routine at 04:00.
schedule:
  kind: cron
  expression: "50 {dayBoundaryHour-1} * * *"

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
# Writes are silent and idempotent (no user-visible output, no /api/notify).
# profile.md pre-exists and is appended/patched, so file presence is not a
# meaningful per-run signal — documented here, no criterion asserted.
outputs:
  - identity/profile.md
  - "identity/<topic>.md"

success_criteria: []

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: normal
  services_lost:
    - "Pre-morning user/profile.md refresh from the day's DM traffic"
  dependent_agents:
    - morning-routine
  reactivation_hint: "Re-enable from /agents/user-profile-sweep-morning. Runs 10 min before the day boundary."
---

# User Profile Sweep (Morning)

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.user_profile_sweep.md` (phase: morning).
