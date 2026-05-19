---
kind: reference
name: op-briefing
description: Operation 3 — weave a latent profile question into the morning briefing inside scheduled.dm's ## Morning briefing sub-flow. Slot-filled pre-check, domain overlap, two PATCHes.
---

# Operation 3 — Latent piggyback (morning briefing composition)

Run this inside the `## Morning briefing` sub-flow of
`scheduled.dm.md`. The briefing is already an outgoing DM the agent
composes; it is one of the few naturally-occurring opportunities to
slip in a question without surfacing a cold standalone DM.

```
1. GET agent/profile-questions.md ## In Progress.
2. If no entry has state=latent, skip.
2.5 Slot-filled pre-check (MANDATORY). Same recipe as Operation 2
   step 2.5: GET /api/profile-questions/slot-filled. If
   `filled: true`, resolve the row (tick Pending, remove In Progress,
   append `- [x] <today> → <id> (reconciled:opportunity)` to Answered,
   remove the matching `Profile question (latent):` line from
   today.md ## Agent Notes) and skip the piggyback — DO NOT weave the
   question.
3. Decide whether the briefing's main content overlaps with the
   question's domain (work questions when the day is calendar-heavy
   with work meetings; personal questions when the day is light /
   personal). If yes, weave one question into the briefing as a
   closing side note. Same naturalness rules as Operation 2 — no
   preamble, no separate paragraph.
4. After composing, issue two PATCH replaces (separate calls):
   - `PATCH /api/context/agent/profile-questions` section=in_progress —
     flip the entry to
     `state=asked :: since=<unchanged> :: asked_at=<current_time>`
     (preserve the original `since=` date).
   - `PATCH /api/context/today` section=agent_notes — flip the
     matching `Profile question (latent):` line by changing the
     parenthetical to `(asked HH:MM)`.
```

## What "natural piggyback" means in this sub-flow

The briefing already enumerates today's calendar items, deltas since
yesterday, and any flagged inbound from the overnight window. A
piggyback question should feel like a side comment on one of those —
"the design review is at 14:00 — what's your usual ramp-up before
those?" — not a separate `## Question:` paragraph.

If the briefing's main content does not have any natural anchor for
the latent question's domain, do not force it. Leave the entry
`state=latent` and let Operation 2 catch it on the next DM the user
sends.
