---
kind: reference
parent_skill: user-interview
---

## Operation 5 — Stale recovery + fallback promotion (evening sweep)

Run inside `routine.user_profile_sweep.md` evening phase, AFTER the
existing user-profile sweep steps.

```
A. STALE RECOVERY.
   For each ## In Progress entry with state=asked older than 24h:
     - Remove from ## In Progress.
     - Refresh `<!-- last_attempted=YYYY-MM-DD -->` on the matching
       ## Pending row (PATCH replace; read-rebuild the row line, swap
       the comment, leave siblings byte-for-byte). Do NOT tick the row
       — the user did not reply.
     - Remove the matching `Profile question (asked HH:MM): <id>` line from
       today.md ## Agent Notes (PATCH replace, read-rebuild). Without
       this, the line lingers in today.md until the next morning's
       PUT-replace.

B. LATENT FALLBACK PROMOTION.
   For each In Progress entry with state=latent: compute
   `today − since` (the `since=YYYY-MM-DD` field is the date the
   morning routine added the entry). Skip rows under 3 days. For rows
   at or over 3 days latent:
     - If the user has been DMing actively in the past 24h, promote to
       state=scheduled. Register POST /api/schedule with:
         {time: tomorrow @ 14:00 local (or quiet_hours_end + 2h),
          taskType: "dm_session",
          prompt: "profile_interview:<id> — run Operation 6 (the
                   scheduled.dm ## Profile interview sub-flow): fire-time
                   slot-filled abort check, then compose one short natural
                   DM around <ask-hint>.",
          description: "profile_interview:<id> — <ask-hint>",
          tier: "medium",
          taskContext: {scheduledBy: "user_profile_sweep_fallback",
                        queueId: "<id>", importance: "low"}}
       NOTE: `prompt` is REQUIRED by POST /api/schedule (the wake-up
       session has NO memory — the prompt is its only instruction).
       `description` is the short list label whose `profile_interview:<id>`
       prefix triggers Operation 6; keep both fields.
       Update the In Progress entry to
       `state=scheduled :: since=<unchanged> :: scheduled_at=<tomorrow 14:00>`.
       Remove the matching `Profile question (latent): <id>` line from
       today.md ## Agent Notes (PATCH replace, read-rebuild — preserve
       all other Agent Notes lines byte-for-byte). The line would
       otherwise misrepresent state until tomorrow's PUT-replace, and a
       briefing piggyback on the morning of the fallback would have
       nothing to flip.
     - If the user has been inactive for ≥ 24h, treat as "no opportunity
       arose, defer". Refresh `<!-- last_attempted=<today> -->` on the
       Pending row, remove the In Progress entry, and remove the
       matching `Profile question (latent):` line from today.md ## Agent Notes.
       Tomorrow's morning routine will pick a different row (this one
       has 7-day cooldown).

C. LAYER 4 LLM RECONCILE.
   GET each distinct target_path in queue.
   For each ## Pending row, judge with model reasoning whether the
   target section substantively answers the question's intent (using
   <id>, target_path, anchor, ask-hint, current section body).
   - TICK path: section answers the question → flip [ ] → [x] (replace),
     append `- [x] <today> → <id> (reconciled:sweep)` to ## Answered.
   - UNTICK path: an entry in ## Answered is tagged
     `(reconciled:skeleton)` or `(reconciled:morning)` AND the target
     section does NOT actually answer (heuristic false positive). Add
     the row back to ## Pending with `<!-- last_attempted=<today> -->`,
     remove the ## Answered entry. NEVER untick `(DM)`, `(import:*)`,
     `(reconciled:fire-time)` — those are user-confirmed closures.
```

## Operation 6 — Fallback DM (scheduled.dm.md `## Profile interview` sub-flow)

Triggered when a `dm_session` task description starts with
`profile_interview:<id> — <ask-hint>`. This is the rare case (Operation
5B) where 3 days passed without a natural opportunity.

```
1. Fire-time abort. GET state/profile-questions.md and the row's
   target_path. Call /api/profile-questions/slot-filled. If the slot is
   filled per the heuristic OR the matching Pending row is no longer
   `[ ]`:
     - Flip the row to [x] if still [ ] (read-rebuild + replace).
     - Append `- [x] <today> → <id> (reconciled:fire-time)` to Answered.
     - Remove the In Progress entry.
     - Append a one-line entry to today.md ## Agent Log:
       `- HH:MM [profile-interview] aborted <id>: target already filled`
     - End the turn with NO assistant text. shouldNotify is unconditional
       for scheduled.dm — empty turn = no DM sent.
2. Otherwise compose a single short DM in <settings primary_language>
   phrased naturally around <ask-hint>. Do NOT mention the queue, the
   id, the schedule, or the word "interview". Treat skipped / "later"
   replies cleanly — no follow-up DM the same day.
3. After composing (final assistant text ready), PATCH the In Progress
   entry to `state=asked :: since=<unchanged> :: asked_at=<current_time>`.
   (`since=` was set by the morning routine when the row was first
   picked latent; preserve that date even though we're now flipping
   from scheduled → asked.)
```
