---
kind: reference
name: op-morning
description: Operation 1 — pick a profile-interview question during Morning Routine Step 7.5. Skip gates, walk order, drift-tick recovery, today.md mirror, no-schedule rule.
---

# Operation 1 — Pick a question (Morning Routine Step 7.5)

Run this only inside `routine.morning_routine` (and its split
variants `routine.morning_routine_today`). DM handlers, scheduled.dm
briefings, and hourly checks do not run this operation — they use
Operation 2 / 3 / 4 instead.

```
1. GET agent/profile-questions.md.
2. Skip the entire step if any of:
     - ## In Progress is non-empty.
     - ## Pending is empty.
     - User has not sent a DM in the last 24h.
     - Day-type focus for [personal] on line 2 of <today> is `off`.
     - This is the first-run morning routine (`<yesterday>` is absent
       from your prompt context — the wizard just finished setup and a
       profile question on day 1 piles onto an already busy onboarding
       surface). Pre-Phase-4 this was keyed off the
       `routine.morning_routine_initial` process key, which the
       dispatcher no longer emits — both branches now route through
       `routine.morning_routine` and the cue is `<yesterday>` absence.
3. Walk Pending rows in priority order (HIGH → MID → LOW, then file
   order). For each candidate:
     a. If the row carries `<!-- last_attempted=YYYY-MM-DD -->` and
        that date is within the last 7 days, skip — cooldown.
     b. Call /api/profile-questions/slot-filled for the row's target.
        If the slot turns out to be filled (Layer 2 catches drift
        since last sweep), tick the row [x] (read-rebuild + replace)
        and append `- [x] <today> → <id> (reconciled:morning)` to
        ## Answered. Continue to the next candidate.
     c. Otherwise, this is the chosen row. Stop walking.
4. Append a single line to today.md ## Agent Notes (latent-question
   flavor, see "Today.md surfacing" in the skill body):
     `- Profile question (latent): <id> — wait for natural opportunity`
5. Append to ## In Progress in the queue file (PATCH replace,
   read-rebuild):
     `- <id> :: state=latent :: since=<today>`
   The `since=` date is load-bearing — the evening sweep needs it to
   compute the 3-day fallback threshold.
6. Do NOT POST /api/schedule for this row. Latent rows are NOT
   scheduled DMs — they wait for an opportunity.
```

## Why no schedule?

A cold scheduled DM that asks "what's your timezone?" out of nowhere
is exactly the failure mode the queue exists to avoid. The latent row
sits in `## In Progress` until either Operation 2 (DM-handler
opportunity match) or Operation 3 (morning briefing piggyback)
naturally weaves it in. Only the evening sweep's Operation 5B fallback
(3 days latent without an opportunity, user still active) escalates to
a scheduled DM — and that's the design's safety valve, not the
primary path.
