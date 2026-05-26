{context}

## Scheduled Task
Origin: {event_data[source]}
Task: {event_data[task]}

<task_context>
{event_data[task_context]}
</task_context>

This session MUST close the Agent Plan loop before returning. Follow the
context skill "Agent Plan lifecycle — scheduled tasks MUST close the
loop" section for the exact read-before-write recipe and failure annotations.

## Output contract — your final text becomes a DM

Scheduled tasks forward your final assistant text to the user as a DM
(routine events do not). Anything you write at end-of-turn is a chat
message the user reads — plan the closing turn accordingly.

- **Default: empty.** Bookkeeping (Agent Plan flip, Agent Log entry) is
  invisible by design — end the turn with no text, no "Done" / "OK",
  no recap of what you wrote to disk. If `/api/notify` already carried
  the user-facing content, the final response MUST also stay empty: a
  follow-up "Sent" / "Closed" line is a duplicate.
- **Non-empty only when** the task's job is to deliver a short message
  AND you did not call `/api/notify`. Write the message itself, not a
  meta-report about it.
- **Never name internal mechanisms** in the final text: no `state/today.md`,
  `## Agent Plan`, `## Agent Log`, `did-not-fire`, "DM sent", "logged",
  "closed the row" — those go in Agent Log only. The same rule applies
  in whatever language you respond to the user; no status-word openers
  ("Done", "OK", "Sent") in any language.

### Bad — the exact noise to avoid
```
Done.
- Sent the morning briefing as a WhatsApp notification.
- Closed the `10:00 morning briefing` row in Agent Plan as `[x]`.
- Logged `17:16 [agent_plan] morning briefing — DM sent` to Agent Log.
```

### Good — reminder task, no /api/notify call
```
14:00 design review in 15 min — Sarah, Mike, API v2 breaking changes.
```

## Provisional roadmap reminder contract

If `{event_data[task]}` or `<task_context>` contains
`[provisional ...]`, the roadmap item came from a Long-term Plans
review and is not yet a confirmed instruction. User-facing text must
ask for confirmation before treating the plan as definite.

- Good: `Assuming you're going to LA next month, OK to start ESTA prep?`
- Bad: `Start the ESTA application today.`

Keep the message short. Output language: follow `<output_language_policy>`.
Preserve the uncertainty unless the task context includes a later
confirmation.

> **DM-tone scheduled tasks live elsewhere.** Morning briefing,
> evening summary, and any other session that should run under the
> conversational profile and deliver as a DM flow through
> `scheduled.dm.md` (event type `scheduled.dm`, task_type
> `dm_session`). This file is for non-DM-tone scheduled work only.

### Step 1: Locate the originating Agent Plan row
1. GET /api/context/today. Scan ## Agent Plan for a row whose HH:MM and action
   text match this scheduled task. If multiple rows share the HH:MM, prefer the
   one whose trigger (→DM / →notify / ...) matches the task's kind.
2. Extract the row's `[category]` tag — this determines whether the filter
   applies to this action.
3. If no matching row exists (the user hand-edited today.md or the row was
   never written): skip the flip later, but still execute the action and log
   to ## Agent Log as usual. Do not re-create the row.
4. **DM-originated tasks — reconcile the roadmap `Scheduled:` entry.**
   When the `Origin:` line at the top of this prompt reports `dm` (i.e.
   the task was registered through `POST /api/schedule/dm` or a DM
   long-horizon intent), reconcile the roadmap entry per the steps
   below. **The dispatcher does NOT inject `<roadmap_write_lock_id>`
   for `scheduled.task` events**, so you must acquire the lock
   explicitly before the first write and release it after the final
   write, or concurrent roadmap_refresh sessions will race.

   Recipe:
   1. `POST /api/context/lock/roadmap` → read back the `lockId` field.
      If the response is 409 (another session holds the lock), back
      off 30 s and retry up to 3 times. If still held, **skip the
      roadmap flip entirely** — the next refresh reconciles — and
      proceed to Step 3 below so the task still executes.
   2. `GET /api/context/plans/roadmap` and locate the matching
      `### Scheduled: ... (task #<id>)  <!-- id: rm-... -->` entry.
      Flip only its Status line to `running` via `PATCH`
      `section=agent_action_plan` `mode=replace` (include
      `X-Lock-Id: <lockId>`). Preserve the heading ID marker and any
      `completed ...` Preparation Timeline rows byte-for-byte.
      Follow the **roadmap** skill for the exact entry shape.
   3. Execute the task body (the remaining steps in this prompt).
   4. After Step 4 closes the loop, PATCH the entry Status to
      `completed` / `failed` (`X-Lock-Id: <lockId>`), then
      `DELETE /api/context/lock/roadmap` with `{"lockId": "<lockId>"}`
      — always release even on failure paths.

   If no matching entry exists in Phase 1's GET, do not create one
   here — release the lock immediately and let the next
   `routine.roadmap_refresh` reconcile.

### Step 2: Apply the day-type filter
4. Read the day-type header on line 2 of <today>. Map the row's category
   to its focus dimension (see the skill's "Category → focus-dimension
   mapping"). If that focus is now `off`, this is a skip:
   - Do NOT execute the action.
   - Proceed to Step 4 to close the loop with outcome `skipped (focus off)`.

### Step 3: Execute (only if not skipped)
5. Execute the task. Use Daemon API (curl) as needed.
   Use <today> for day state and <calendar_today> for live calendar events.
   If the task description is unclear or lacks critical details (who, what,
   when, why), do NOT guess — log `ambiguous task — skipped` to Agent Log
   and proceed to Step 4 with outcome `skipped (ambiguous)`.

### Step 4: Close the loop (MANDATORY — every path reaches here)
6. Append one line to ## Agent Log (PATCH append, section=agent_log):
   `- HH:MM [agent_plan] <action summary> — <outcome>`
   Outcome taxonomy: DM sent / notify sent / check-in scheduled /
   skipped (focus off) / skipped (quiet hours) / skipped (user in meeting) /
   skipped (ambiguous) / failed: <reason>.
7. If Step 1 found a matching Agent Plan row, flip it to `- [x]` via the
   lifecycle recipe in the context skill (GET → edit body → PATCH
   replace section=agent_plan). Annotate per the skill's outcome table:
   success = no annotation, skip = `(skipped: <reason>)`, failure =
   `(failed: <reason>)`. Never leave a past-HH:MM row as `[ ]`.
8. If the PATCH returns 409 (Morning Routine lock), follow the skill's
   "retry 3 times, else log deferred" guidance. Do not drop silently.

### Step 5: Follow-up (optional)
9. Register follow-up wake-ups if the action produced new work (schedule skill).
10. For additional context if needed:
    - GET /api/context/plans/roadmap — long-term goals and milestones
    - GET /api/context/plans/projects/_active — active projects summary
