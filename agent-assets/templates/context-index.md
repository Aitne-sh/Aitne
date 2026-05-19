---
type: index
owner: agent
updated: 2026-04-17
template_version: 1
---
# Context Index

Prompt-injection hub for dossier-backed flows (B-004). This file stays in
English so review / routine prompts read a stable, backend-neutral summary.

## Files

| Path | Purpose | Review flows | Last touched |
|---|---|---|---|
| `_index.md` | Human-readable vault navigation | - | 2026-04-17 |
| `user/profile.md` | User identity, preferences, communication style | all | 2026-04-17 |
| `today.md` | Current-day schedule, tasks, agent plan, handoff | hourly, morning, evening | 2026-04-17 |
| `roadmap.md` | Long-horizon commitments and recurring plans | evening, weekly, monthly, roadmap | 2026-04-17 |
| `projects/_index.md` | Project area index | weekly, monthly, roadmap | 2026-04-17 |
| `agent/journal.md` | Agent-internal reflection log | weekly, monthly | 2026-04-17 |
| `rules/management.md` | Source-of-truth bindings and behavioral policy | all | 2026-04-17 |
| `rules/redaction.md` | Secret and private-data handling rules | all | 2026-04-17 |
| `routines/hourly.md` | Hourly check rulebook | hourly | 2026-04-17 |
| `routines/morning.md` | Morning routine extension rulebook | morning | 2026-04-17 |
| `routines/evening.md` | Evening review extension rulebook | evening | 2026-04-17 |
| `routines/weekly.md` | Weekly review extension rulebook | weekly | 2026-04-17 |
| `routines/monthly.md` | Monthly review and roadmap planning rulebook | monthly, roadmap | 2026-04-17 |
| `dossiers/hourly.md` | Hourly carry-forward state | hourly | 2026-04-17 |
| `dossiers/morning.md` | Morning carry-forward state | morning | 2026-04-17 |
| `dossiers/evening.md` | Evening carry-forward state | evening | 2026-04-17 |
| `dossiers/weekly.md` | Weekly carry-forward state | weekly | 2026-04-17 |
| `dossiers/monthly.md` | Monthly carry-forward state | monthly | 2026-04-17 |
| `dossiers/roadmap.md` | Roadmap refresh carry-forward state | roadmap | 2026-04-17 |

## Notes

- Keep `Review flows` short: `all`, `hourly`, `morning`, `evening`,
  `weekly`, `monthly`, and `roadmap` are the flow tags the prompt loader
  understands.
- When a new context file should be reviewed routinely, add one row here
  with the narrowest matching flow tag.
