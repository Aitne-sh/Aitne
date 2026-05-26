---
type: index
owner: shared
updated: 2026-04-22
template_version: 1
---
# Routines

Per-cadence check lists the agent runs when a `routine.*` ProcessKey
fires. Each file holds the full list of checks (both initial and any that
I've added later via DM). All checks are treated equally.

| File | Cadence | Process key |
|---|---|---|
| `hourly.md` | every hour | `routine.hourly_check` |
| `morning.md` | 04:00 daily | `routine.morning_routine` |
| `evening.md` | evening | `routine.evening_review` |
| `weekly.md` | Friday | `routine.weekly_review` |
| `monthly.md` | month-end | `routine.monthly_review` |
| custom/<slug>.md | user-defined cron in `policies/routines/custom/` | `routine.custom.<slug>` |
