---
kind: reference
name: agent-plan-lifecycle
description: Agent Plan close-the-loop lifecycle for scheduled.task / scheduled.dm sessions — execute, log, flip [x], handle missing rows / failures / lock retries.
---

# Agent Plan lifecycle — close the loop

This reference is consumed by `scheduled.task`, `scheduled.dm`,
`routine.morning_routine`, and `routine.evening_review` — every event
that flips an Agent Plan row at fire time. DM handlers and hourly
checks never flip rows for execution outcomes; their one write path is
the pre-fire cancel / amend revision in the `today` skill body, not
this lifecycle.

## Why flip inside the scheduled task, not later?

The user may DM at 09:00 asking "did you send the reminder?" — if the
matching Agent Plan row is still `[ ]`, the DM handler cannot tell
whether the reminder was sent. The flip must land in the same turn as
the action it represents, before the session exits.

## Steps (when spawned by `scheduled.task` for an Agent Plan row)

1. **Execute the task.** Send the DM, fire the notification, run the
   check-in — whatever the row's action text describes. The row's
   trigger tag (`→DM`, `→notify`, `→check-in`, `→wake`) selects the
   API surface (see `today` skill §"Entry formats").

2. **Append an Agent Log entry** describing the outcome:

   ```
   - HH:MM [agent_plan] <action> — <outcome>
   ```

   Outcomes (use exactly one, lowercase):
   - `DM sent`
   - `notify sent`
   - `check-in done`
   - `wake fired`
   - `skipped (<reason>)` — e.g. `skipped (user in meeting)`,
     `skipped (focus off)`, `skipped (deduped)`
   - `failed: <reason>` — short, single-line, no stack trace

   Agent Log entries are mandatory before the flip, not after. If the
   PATCH that flips the row to `[x]` fails, the log entry is the only
   record that the action ran.

3. **Read today.md, locate the matching Agent Plan row** (match HH:MM
   + action text), and flip `[ ]` → `[x]`:

   ```bash
   curl -s http://localhost:8321/api/context/state/today
   # Find the agent_plan section. Edit the matching row's checkbox.
   # Then PATCH the full updated section body:
   curl -s -X PATCH http://localhost:8321/api/context/state/today \
     -H 'Content-Type: application/json' \
     -H 'X-Lock-Id: <today_write_lock_id>' \
     -d '{"section": "agent_plan", "mode": "replace", "content": "<full merged section>"}'
   ```

   **Read-before-write is mandatory** — `PATCH mode: "replace"` replaces
   the entire section body. Send only the flipped row and you erase
   every other Agent Plan row.

4. **If the Agent Plan row is missing** (user hand-edited, row was
   pruned by Evening Review, race with a concurrent rewrite), log
   `skipped (row_missing)` to Agent Log and exit. Do not append a
   new row to back-fill — the row's absence is informative state.

## Flip-to-[x] cardinality rule

**Always flip to `[x]`, even for skips and failures.** The cardinality
rule is: every Agent Plan row reaches exactly one terminal state per
agent-day, and that state is `[x]`. Annotate the non-success cases in
parentheses appended to the action text:

| Outcome | Row content after flip |
|---|---|
| Success | `- [x] HH:MM <action> [category] →<trigger>` (no annotation) |
| Skip | `- [x] HH:MM <action> [category] →<trigger> (skipped: <reason>)` |
| Failure | `- [x] HH:MM <action> [category] →<trigger> (failed: <reason>)` |

Leaving rows as `[ ]` is a bug: Morning Routine's reconciliation
treats unflipped past rows as "scheduler dropped the wake", which
triggers self-recovery and inflates the agent-actions audit.

A fourth terminal state — `(cancelled: <reason>)` — is written before
fire time by the cancel / amend revision path (today skill body),
never by this lifecycle.

## Lock retry rules

The Morning Routine holds the `state/today.md` write lock. Other sessions
get `409 morning_routine_lock_held` on PUT / PATCH while the lock is held.

- Detect by the response body `{"error":"morning_routine_lock_held"}`
  (with `errors[0].code: "context.morning_routine_lock_held"`) or by the
  status code 409 alone.
- Retry policy: 30 s back-off, max 3 attempts. If the third attempt
  also returns 409, log `loop-closeout deferred (lock_held)` to Agent
  Log and exit. The next Morning Routine reconciliation will catch the
  un-flipped row.
- Do NOT retry without the `X-Lock-Id` header when the tag is in
  context. Sending a PATCH without the header during a held-lock
  window returns 409 even though you would have been allowed in
  during a no-lock window.

## What this lifecycle does NOT cover

- Agent Notes flavors and their flips (`Profile question (latent)` ↔
  `Profile question (asked HH:MM)`) — those live in the
  `user-interview` skill, not in this lifecycle.
- The schedule.approaching → Agent Notes / Agent Log format — that
  is in the `today` skill body (§"schedule.approaching → Agent Notes
  + Agent Log"), not here. The 15-minute firing gate is the daemon's,
  not the skill's.
- The Morning Routine's initial population of Agent Plan rows — see
  the morning routine task-flow.
