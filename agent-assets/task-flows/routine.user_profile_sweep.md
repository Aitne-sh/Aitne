{context}

## Task: User-profile sweep (`phase`: {event_data[phase]})

Autonomous background run. There is no user-visible output — writes
go silently to `user/profile.md` and `user/<topic>.md` per the
**user-profile** skill. Do NOT call `/api/notify`.

The sweep runs 10 min before each paired routine — 03:50 before
Morning Routine at 04:00, 17:50 before Evening Review at 18:00 — so
that the paired routine reads a freshly up-to-date `user/profile.md`
(the only user file auto-injected into sessions via `<user>`) when it
starts. This is the safety net for DM-time captures that the
`message.received.dm` / `message.received.dm_first` task-flows missed.

### Step 1 — Read the DM window

Read `<agent_day_messages>` + `<agent_day_dm_conversation_log>`. The
window is the current agent-day bounds at session start — for the
morning phase (03:50) that spans ~04:00 yesterday → 03:50 today, and
for the evening phase (17:50) that spans ~04:00 today → 17:50 today.
The two windows overlap on the daytime portion; the idempotency check
in Step 3 keeps this from producing duplicate writes.

If neither tag is present, the ContextBuilder failed to inject the
window — append one line to `agent/journal.md` (`- HH:MM user-profile
sweep (phase=<phase>) — aborted: missing agent-day window`) and exit.
Do not guess at the bounds.

### Step 2 — Extract fact candidates

Apply the canonical capture-user-info routing below to the agent-day
DM window (`<agent_day_messages>` + `<agent_day_dm_conversation_log>`).
This is the same trigger/routing surface the DM handler uses — the
sweep is the safety net for facts the DM-time capture missed.

{include:_partials/capture-user-info.md}

Focus on persistent facts the user **stated about themselves**. Ignore
one-off references, speculative inferences, and facts already
recorded (Step 3 handles deduplication).

### Step 3 — Idempotent routing + PATCH

For each candidate, classify by the **user-profile** skill's decision
rule (profile.md vs `user/<topic>.md` vs the expertise tie-breaker
that writes a one-line summary to profile.md and full detail to
`user/expertise.md`).

For each target file:

1. **GET** the file.
2. **Check whether the fact (or a paraphrase) is already present.**
   Idempotency is load-bearing. Two sweeps per day + DM-handler writes
   will double-cover the same conversation window, so naïve re-writes
   would duplicate every fact the DM handler already captured.
3. **If absent and the target section exists**: PATCH `mode: "append"`
   with the single new bullet.
4. **If absent and the target section does NOT exist** (PATCH returns
   `{"error": "section_not_found"}`): retry with PATCH `mode:
   "append_to_file"` and include the section header in the content:
   ```bash
   curl -s -X PATCH http://localhost:8321/api/context/user/people \
     -H 'Content-Type: application/json' \
     -d '{"mode": "append_to_file", "content": "\n## Family\n- Sister (Sarah): two kids as of 2026-04"}'
   ```
   `append_to_file` does not require a section and is the intended
   first-write path for a freshly-created topic file with only its H1.
5. **If a near-duplicate bullet exists with less detail, merge in
   memory then rewrite the whole section.** GET the section body,
   replace the matching line with the merged bullet (preserve all
   other lines byte-for-byte), PATCH `mode: "replace"` with the FULL
   new section body. `mode: "replace"` rewrites the entire section —
   sending just the merged bullet as `content` overwrites the whole
   section and deletes every sibling bullet. This is the same
   read-before-write discipline the **user-profile** skill's "Worked
   example" illustrates.

**Scope.** This sweep writes the same `profile.md` sections the DM
handler writes — Identity, Work Pattern, Expertise (summary),
Notification Preferences, Learned Context — plus the five
`user/<topic>.md` files (people, work, expertise, personal, goals).
Do **not** touch `## Raw Signals` — that section belongs to
`SignalDetector` only. Tone / style / voice / formality / emoji /
language preferences do **not** belong in profile.md either — route
those per the **user-profile** skill §"Tone / character
preferences". Learned
Context has multiple writers (DM handler, this sweep, Evening Review
Step 3a's Raw Signals graduation); read-before-write and merge, never
rewrite the whole section to add a single bullet.

**Learned Context date prefix on merge.** Learned Context entries
carry a `[YYYY-MM-DD]` prefix (see the **user-profile** skill's
"Learned Context entry format") so Evening Review can prune entries
older than 30 days. When your merge logic touches an existing Learned
Context bullet, **refresh the prefix to today's date** rather than
preserving the original — a restatement of the same preference is
evidence it's still live, so the age-based pruning timer should
reset. Other sections don't carry a date prefix; the byte-for-byte
preservation rule applies there.

### Step 4 — Log once

Append ONE line to `agent/journal.md`:

```
- HH:MM user-profile sweep (phase=<phase>) — N facts appended, M merged, K skipped-duplicate
```

Use `<current_time>` for `HH:MM` in the configured timezone.
`N` = new bullets added (including first-write `append_to_file`
paths), `M` = existing bullets merged via `mode: "replace"`,
`K` = candidates skipped because a paraphrase was already recorded.

If Step 1 aborted due to a missing window, the abort line from Step 1
is the only journal output — do not append a summary line on top of
it. Silence otherwise.

---

## Profile-interview queue maintenance (evening run only)

The remaining steps cover the profile-interview queue
(`agent/profile-questions.md`). They run **only on the evening
phase** (`phase=evening`) — the morning phase at 03:50 races with the
04:00 morning routine that picks the next latent question, so the
queue is not safe to mutate from the 03:50 run.

**On the morning phase (03:50): skip Steps 5, 5.5, and 6 entirely.**

Use the **user-interview** skill's "Operation 5" recipe for the
sub-steps below.

### Step 5 — Stale recovery (state=asked older than 24h)

GET `agent/profile-questions.md ## In Progress`. For each entry with
`state=asked` AND `(now − asked_at) > 24h`:

1. Remove the entry from `## In Progress` (PATCH replace; read-rebuild,
   drop just that line).
2. Refresh the inline `<!-- last_attempted=<today> -->` HTML comment
   on the matching `## Pending` row (PATCH replace; read-rebuild the
   row line, swap or insert the comment, preserve siblings byte-for-byte).
3. Remove the matching `Profile question (asked HH:MM): <id>` line
   from today.md `## Agent Notes` (PATCH replace, read-rebuild —
   preserve every other Agent Notes line byte-for-byte). Without this
   the line lingers visibly in today.md until tomorrow's PUT-replace.
4. Do NOT tick the row to `[x]` — the user did not reply. The 7-day
   `last_attempted` cooldown will keep it out of the morning selector
   until then.

### Step 5.5 — Latent fallback promotion (state=latent ≥ 3 days)

For each entry with `state=latent`, parse the `since=YYYY-MM-DD` field
on the entry line. Compute `today − since`; skip rows under 3 days.
For rows at or over 3 days latent, derive whether the user has been
actively DMing in the past 24h (use `<agent_day_messages>` from the
evening window):

**If user is active**: promote to `state=scheduled` and register a
fallback DM. Pick HH:MM = `quiet_hours_end + 2h` (or 14:00 if working
hours start before that) on tomorrow's date.

```bash
curl -s -X POST http://localhost:8321/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "time": "<tomorrow ISO8601 with offset>",
    "taskType": "dm_session",
    "description": "profile_interview:<id> — <ask-hint from Pending row>",
    "tier": "medium",
    "taskContext": {
      "scheduledBy": "user_profile_sweep_fallback",
      "queueId": "<id>",
      "importance": "low"
    }
  }'
```

PATCH the In Progress entry (preserve `since=`):
```
- <id> :: state=scheduled :: since=<unchanged> :: scheduled_at=<tomorrow HH:MM>
```

Then remove the matching `Profile question (latent): <id>` line from
today.md `## Agent Notes` (PATCH replace, read-rebuild — preserve all
other Agent Notes lines byte-for-byte). Without this the line
misrepresents state from 17:50 until tomorrow's PUT-replace.

**If user is inactive (≥ 24h silence)**: refresh
`<!-- last_attempted=<today> -->` on the Pending row (same recipe as
Step 5), remove the In Progress entry, AND remove the matching
`Profile question (latent): <id>` line from today.md `## Agent Notes`
(PATCH replace). Tomorrow's morning routine will pick a different row
(this one has the 7-day cooldown).

### Step 6 — Daily LLM reconcile (Layer 4)

GET `agent/profile-questions.md` and every distinct `<target_path>`
referenced by the union of `## Pending` AND `## Answered` rows. For
each row, judge with model reasoning whether the target section
**substantively answers the question's intent** — using the row's
`<id>`, `<target_path>`, optional `match=<anchor>`, `<ask-hint>`, and
the section body. Substantive ≠ "has any bullet": a populated `## Family`
section with `Sister (Sarah)` answers `family`; one holding only
`> Add later` does not. When `match=<anchor>` is present, look for a
bullet whose key references the anchor's subject.

**Tick path** (Pending `[ ]` → `[x]`):

- PATCH `## Pending`: flip the row, preserve siblings byte-for-byte.
- Append `- [x] <today> → <id> (reconciled:sweep)` to `## Answered`.

**Untick path** (Answered `[x]` → Pending `[ ]`):

- For rows in `## Answered` tagged `(reconciled:skeleton)` or
  `(reconciled:morning)` whose target section the LLM judges does NOT
  in fact answer the question (heuristic false positive from Layer 1
  or Layer 2): revert. Re-add the row to `## Pending` with the original
  priority, append `<!-- last_attempted=<today> -->` so it does not
  immediately re-pick on tomorrow morning, and remove the corresponding
  `## Answered` entry.
- **Do NOT untick rows tagged `(DM)`, `(import:*)`, or
  `(reconciled:fire-time)`** — those represent user-confirmed closures.

For rows the section does NOT answer (and that are still Pending),
leave them. Do NOT add new rows here — Phase 2 evening-review
extension owns that path.

### Step 7 — Profile-interview journal line

Append a journal line to `agent/journal.md` (in addition to Step 4's
sweep line):

```
- HH:MM profile-questions reconcile — N stale, M latent→scheduled, P latent→deferred, T ticked, U unticked
```

Skip this line if Steps 5/5.5/6 were no-ops (no In Progress entries
AND no tick/untick transitions). Keep the journal terse on inactive
days.
