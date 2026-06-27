---
type: index
owner: agent
updated: 2026-04-22
template_version: 1
---
# Dossiers

Per-flow context dossiers (B-004). Populated by the agent; each dossier
captures enough context to run a specific review / routine without
re-scanning the full vault.

Injected into prompts through the root-level context-index.md catalog.

| File | Process key |
|---|---|
| `activity-scan.md` | `routine.activity_scan` |
| `morning.md` | `routine.morning_routine`, `routine.morning_routine_today` |
| `evening.md` | `routine.evening_review` |
| `weekly.md` | `routine.weekly_review` |
| `monthly.md` | `routine.monthly_review` |
| `plans/roadmap.md` | `routine.roadmap_refresh` |
