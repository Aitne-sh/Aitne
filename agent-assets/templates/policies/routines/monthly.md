---
type: rule
slug: monthly
owner: shared
updated: 2026-04-17
template_version: 1
---
# Monthly Review Checks

Fires on the last calendar day of the month. Output target:
`monthly/YYYY-MM.md`.

## Checks

### Aggregate the month
- **Action**: read all `weekly/*.md` from the month, plus major
  `daily/*.md` items

### Roadmap delta
- **Action**: compare current `plans/roadmap.md` against the month's progress;
  highlight completed + delayed items

### Habit + health snapshot
- **Action**: if the user logged health/habit data in `identity/personal.md`,
  surface month-over-month changes (opt-in only)
