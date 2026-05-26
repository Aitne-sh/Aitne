---
type: rule
slug: weekly
owner: shared
updated: 2026-04-17
template_version: 1
---
# Weekly Review Checks

Fires Friday evening (configurable). Output target:
`weekly/YYYY-Www.md`.

## Checks

### Aggregate the week
- **Action**: read 5 most recent `daily/*.md` files; extract progress,
  decisions, open threads

### Project status
- **Action**: for each active project, note what moved / what stalled

### Calibrate next week
- **Action**: note 1–3 priorities for next week in the review
