---
kind: reference
name: op-dm-handler
description: Operations 2 and 4 — the DM-handler latent-opportunity weave and the answer-capture queue reconcile. Slot-filled pre-check, naturalness rules, two PATCHes, the "one DM = one tick" rationale.
---

# Operation 2 — Latent opportunity check (DM handler)

Run this AFTER the standard "Capture user info" block in
`message.received.dm.md` / `message.received.dm_first.md`, BEFORE
composing the reply.

```
1. GET state/profile-questions.md ## In Progress.
2. If no entry has state=latent, skip — return to the normal reply path.
2.5 Slot-filled pre-check (MANDATORY before any weaving decision).
   GET /api/profile-questions/slot-filled?path=<target>&section=<section?>&anchor=<anchor?>
   for the latent row's target. If `filled: true`, the slot was filled
   between morning routine and now (the user may have volunteered the
   answer in a previous DM, or the sweep that runs at 17:50 hasn't
   caught up yet). Resolve the row instead of weaving:
     - Tick the matching ## Pending row [ ] → [x] (read-rebuild + replace).
     - Remove the entry from ## In Progress.
     - Append `- [x] <today> → <id> (reconciled:opportunity)` to ## Answered.
     - Remove the matching `Profile question (latent): <id>` line from
       today.md ## Agent Notes.
   Return to the normal reply path — DO NOT weave a question. The user
   has effectively already answered it.
3. Otherwise (slot still empty), judge whether the inbound DM is a
   natural moment to ask the question. The criteria:
     - Topic match. The user's message touches the question's domain
       (work questions when the user mentions a meeting, code, deadline;
       personal questions when the user discusses lifestyle, hobbies,
       weekend plans; identity / location questions when the user makes
       a general greeting on day 1 or asks for time/weather).
     - Length appropriateness. Your reply will be more than a one-liner;
       there is room to weave a question without making the message look
       forced.
     - Mood appropriateness. The user is not venting / in crisis / asking
       a single short factual question.
4. If yes:
     a. Compose the reply with the question woven in NATURALLY. Do NOT
        make a separate paragraph or "By the way, …" preamble. The
        question should feel like a side comment, not an interview cue.
     b. After the reply is ready (final assistant text already includes
        the question), issue **two PATCH replaces** (separate calls —
        they target different files):
        - `PATCH /api/context/state/profile-questions` section=in_progress
          — flip the entry to
          `state=asked :: since=<unchanged> :: asked_at=<current_time>`
          (preserve the original `since=` date).
        - `PATCH /api/context/state/today` section=agent_notes — replace the
          parenthetical from `(latent)` to `(asked HH:MM)` and append
          `(asked HH:MM)` to the same line; preserve every other Agent
          Notes line byte-for-byte.
5. If no, leave the latent entry untouched. Return to the normal reply
   path. The opportunity will come (or the evening sweep will eventually
   promote to a fallback scheduled DM if it doesn't).
```

# Operation 4 — Capture the answer (DM handler queue reconcile)

Run this AFTER "Capture user info" and Operation 2's opportunity check,
BEFORE composing the reply text.

```
1. GET state/profile-questions.md ## In Progress.
2. If an entry has state=asked AND (now − asked_at) < 24h:
     a. Tick the matching ## Pending row [ ] → [x] via PATCH replace
        (read-rebuild full Pending body, change just that one line).
     b. Remove the entry from ## In Progress (PATCH replace).
     c. Append `- [x] <today> → <id> (DM)` to ## Answered.
     d. Remove the matching today.md ## Agent Notes line — match by
        the `Profile question (` prefix and the `: <id>` id segment;
        works for both `(asked HH:MM)` and `(latent)` parenthetical
        states (PATCH replace, read-rebuild — preserve every other line
        byte-for-byte). Without this the line lingers in today.md
        until tomorrow's PUT-replace and confuses the user.
3. If state=latent or state=scheduled, leave the entry alone — this
   inbound DM is by definition unrelated to a question the user has
   not been asked.
```

The "one DM after fire = one tick" rule is intentional. Trying to detect
"did the user ACTUALLY answer?" is unreliable and would re-ask forever
on partial answers. The 7-day `last_attempted` cooldown means an
unresolved fact will surface again later through the natural-volunteering
path or the next opportunity.
