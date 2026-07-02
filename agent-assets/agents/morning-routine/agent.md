---
# ── Identity ─────────────────────────────────────────────────────────────────
slug: morning-routine
name: Morning Routine
description: "Regenerates state/today.md and creates the daily journal entry at the day boundary."
kind: builtin
version: 1
enabled: true
tags: [routine, daily, journal]

# ── Schedule ─────────────────────────────────────────────────────────────────
# `{dayBoundaryHour}` is substituted with the live config value at load
# (default 4 → "0 4 * * *"). The registry (§5.5) is the authoritative cron
# source; the loader emits a non-fatal drift warning on mismatch.
# `timezone` is intentionally omitted — the loader fills it from
# `config.timezone` (US-targeted product; no baked single-zone default).
schedule:
  kind: cron
  expression: "0 {dayBoundaryHour} * * *"

# ── Backend / routing ────────────────────────────────────────────────────────
# `tier`/`model` are null: built-ins defer their routing to
# `process_backend_config` (the seed authority). Operators override per-agent
# from the dashboard (§6.4.1), not here.
backend:
  process_key: routine.morning_routine
  tier: null
  model: null

# ── Limits (per execution) ───────────────────────────────────────────────────
# Mirrors the runtime envelope (plan-presets / process_backend_config seed:
# parent routine.morning_routine and Stage A routine.morning_routine_today are
# both 50 / $2.00). These values prefill the dashboard Definition form; a
# stale lower number saved there would clamp the real runs via
# override_snapshot, so keep them in step with the seed authority.
limits:
  max_turns: 50
  max_budget_usd: 2.00
  timeout_minutes: 15

# ── Expected outputs (informational; drive the dashboard + criteria intent) ──
outputs:
  - state/today.md
  - journal/daily/{date}.md
  - journal/agent.md

# ── Semantic success checks (best-effort, evaluated post-execute) ────────────
# today.md is regenerated wholesale every morning, so a section-count floor is
# a real check (it fails on a degenerate/empty regen). The daily journal is
# written for the *previous* agent-day (`daily/<yesterday>.md`), which the
# `{date}`-only evaluator cannot target, so it is listed under `outputs`
# rather than asserted as a criterion.
success_criteria:
  - id: today_md_populated
    kind: file_section_count
    target: state/today.md
    heading_level: 2
    min: 3

# ── Error handling ───────────────────────────────────────────────────────────
on_error:
  retries: 1
  retry_delay_seconds: 60
  notify_owner: true

# ── Stop warning (byte-identical to BUILTIN_AGENT_REGISTRY, §12.1) ──────────
stop_warning:
  level: critical
  services_lost:
    - "Daily state/today.md regeneration"
    - "Daily journal entry creation"
  dependent_agents:
    - evening-review
    - weekly-review
  reactivation_hint: "Re-enable from /agents/morning-routine. The next firing catches up with a broader observation window."
---

# Morning Routine

Built-in routine — the execution prompt lives in the task-flow, not here.
See `agent-assets/task-flows/routine.morning_routine_today.md` (Stage A — today.md synthesis)
and `agent-assets/task-flows/routine.morning_routine_journal.md` (Stage B — daily journal).
