---
kind: reference
name: importance
description: The `importance` tier convention for `agent_schedule` rows — which tiers surface in `plans/roadmap.md` `Scheduled:` entries, defaults per endpoint, and when to use `strategic`.
---

# `importance` convention

This controls whether `agent_schedule` rows become `plans/roadmap.md`
`Scheduled:` entries:

| Tier | Roadmap behavior | Use |
|---|---|---|
| `transient` | Never in roadmap; surfaces in today.md only on the day it fires | Default for `/api/schedule/dm`; short pings like "call mom next Tuesday" |
| `normal` | In roadmap only when scheduled more than 7 days out | Default for `/api/schedule`; ordinary user-facing follow-ups |
| `strategic` | In roadmap regardless of horizon | Long-prep commitments such as ESTA / travel / deadline reminders |
| `low` | Never in roadmap | Internal ticks already visible elsewhere, e.g. Agent Plan rows, recurring-schedule instances, morning retries |

For direct DMs, omit `importance` for ordinary one-off pings. If the
reminder is clearly tied to a long-prep commitment ("remind me in a
month about ESTA for the LA trip"), either write/promote the roadmap
item via the roadmap skill and let AAP schedule the reminder, or call
`/api/schedule/dm` with `"importance":"strategic"`.
