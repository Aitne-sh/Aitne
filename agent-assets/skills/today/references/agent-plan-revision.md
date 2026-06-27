---
kind: reference
name: agent-plan-revision
description: Pre-fire cancel / amend recipe for Agent Plan rows — schedule + row + Agent Log revised in one turn, with the confidence gate.
---

# Agent Plan revision — cancel / amend recipe

Triggers: the referenced calendar event was cancelled or moved; the
user already handled the item or says it is no longer needed; a
schedule PATCH/DELETE would otherwise orphan the row.

All three in the same turn — lock-step holds in both directions:

1. **Schedule** — `DELETE /api/schedule/:id` to cancel, or
   `PATCH /api/schedule/:id` to re-time. Find the id via
   `GET /api/schedule?status=pending` (match subject + HH:MM).
2. **Row** — read-before-write PATCH of `agent_plan` (lifecycle
   recipe): cancel → flip to
   `- [x] HH:MM <action> [category] →<trigger> (cancelled: <reason>)`;
   amend → update the row's HH:MM / action text, keep `[ ]`.
3. **Agent Log** — `- HH:MM [agent_plan] cancelled <action> — <reason>`
   (or `rescheduled <action> to HH:MM — <reason>`).

Confidence gate: revise only when subject AND time both unambiguously
match the invalidating fact. A wrong cancellation silently never fires
— worse than a stale wake, which fire-time guards can still skip.
Uncertain → leave the pair alone.
