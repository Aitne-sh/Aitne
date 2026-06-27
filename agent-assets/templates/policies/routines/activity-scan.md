---
type: rule
slug: activity-scan
owner: shared
updated: 2026-04-17
template_version: 1
---
# Activity Scan

The daemon fires `routine.activity_scan` every interval (default: every
2 hours) within active hours. This file is injected verbatim via `policy-files.ts`. Each `### <label>` block
is one check. All checks are equal — the agent runs them in order,
skipping any whose preconditions are not met.

## Checks

### Pending observations
- **Precondition**: always
- **Action**: `GET /api/observations/pending`. If ≥3 pending, consume via
  the `observations` skill.

### Upcoming schedule
- **Precondition**: always
- **Action**: scan `state/today.md` `## Agent Plan` for items in the next 60
  min; ensure each has a `scheduled.task` row.

## Skip conditions (applied before any check)
- Morning routine still in progress (runtime_state flag)
- Activity scan already running (atomic flag in runtime_state)
- No check has a firing precondition AND pending observations < 2
