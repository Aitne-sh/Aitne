---
# dm-intent.project — Project DM-intent detection decision tree.
# Included from: message.received.dm.md (Step 4), message.received.dm_first.md
# (Step 4). The `context` skill is the WRITER (PUT / PATCH / archive); this
# partial carries the decision tree that the DM dispatcher applies before
# the writer runs.
---

Referenced from `message.received.dm`, `message.received.dm_first`, and
any other handler that wants to record project-state changes from a DM.
Identifies user messages about a named, ongoing workstream so the
handler can route them into `projects/<slug>.md` instead of letting the
fact bleed into the model's own scratch memory.

This block mirrors the shape of the "Long-horizon DM-intent detection"
partial so future durable-state domains (e.g. git, personal plans)
can copy the same pattern into their own skills.

**Signals (positive):**
- Named project + state verb: *"Project Alpha is now in review"*,
  *"the migration project hit its first milestone"*, *"blocked on Y
  for the reporting overhaul"*.
- New-project shape: *"let's start a project for X"*, *"I'm kicking
  off …"*, *"track this as a project"*, *"add a new project"*. The
  same shape in any other language counts — match on intent, not
  surface vocabulary.
- Status / progress / blocker / decision phrasing tied to a
  recognizable workstream the user has named before.

**Not signals — route elsewhere:**
- One-off task with a single deadline (*"remind me at 3pm to call …"*)
  → `schedule` skill.
- Long-horizon plan with a date or horizon but no named workstream
  (*"going to Tokyo next month"*) → `roadmap` skill ("Long-horizon
  DM-intent detection"). When BOTH apply (a project with a dated
  milestone), run both flows — see "Tie-breakers" below.
- Pure user fact / preference (*"I work on the platform team"*) →
  `user-profile` skill.
- Durable management rule with a recurring cadence (*"every morning,
  X"*) → `management-policy` skill.

**Decision tree:**

1. **Existing or new? (Plus decline-marker pre-check.)**
   - `GET /api/context/list/projects` and match the user's wording
     against returned filenames (slug stem) and, if needed, against
     the H1 / title of each candidate via
     `GET /api/context/projects/<slug>`. If multiple candidates
     match, prefer the one with the closest slug stem; if still
     ambiguous, ask *"is this for `<slug-A>` or `<slug-B>`?"* before
     writing.
   - **Decline-marker pre-check (Goal 3 — never ask twice).** Before
     classifying a no-match as new, compute the candidate slug and
     read `agent/journal.md ## Declined Intents`:
     ```bash
     curl -s "http://localhost:8321/api/context/agent/journal" \
       | jq -r '.content // ""' \
       | awk '/^## Declined Intents/{f=1;next} f && /^## /{exit} f'
     ```
     (404 from the GET means the journal file does not yet exist →
     no marker can exist → treat as "no marker present" and continue
     to the no-match path.) If any line under that section contains
     `create_project:<slug>` (the dedup_key shape — see §"Reply
     branches" below), the user previously declined this exact
     intent. The default behaviour is **skip silently** — do NOT
     re-ask, do NOT schedule a confirm, do NOT write.

     **Reversal-signal carve-out (rare).** If the user's current DM
     contains an unambiguous reversal phrase for this exact intent,
     treat the DM as a fresh affirmative. Run the
     §"Decline-marker reversal" recipe below (remove the matching
     marker line, then PUT the project file per Step 4). Pattern
     shape: explicit verb of resumption + the topic + action
     consent. Match on intent, not surface vocabulary — any
     language qualifies.

     Counts as reversal (do the recipe):
     - *"actually let's start that LA project after all"*
     - *"go ahead and track LA PM"*
     - *"changed my mind, let's do it"*

     Does NOT count as reversal (skip silently, marker stays):
     - bare re-mention without an action verb: *"still thinking
       about LA PM"*, *"made a bit of progress on LA"*
     - status update on the topic without consent: *"LA classes
       started"*, *"midterm was hard"*
     - ambiguous "maybe" / non-commitment: *"maybe I'll track it
       eventually"*, *"might revisit this later"*

     The examples are English for prompt clarity only; recognise the
     same shapes in any language the user writes in. Bias
     conservative — when in doubt, skip silently and wait for a
     clearer signal. A missed reversal costs nothing (user can
     re-state explicitly); a false reversal silently overwrites a
     deliberate "no".

2. **Existing match → append a dated bullet.** Default section is
   `## Log` (or whatever section the file already uses for time-ordered
   entries — match existing files' conventions; do not invent a parallel
   section if one already exists).

   ```bash
   curl -s -X PATCH http://localhost:8321/api/context/projects/<slug> \
     -H 'Content-Type: application/json' \
     -d '{"section": "log", "mode": "append", "content": "- 2026-04-30: <one-line summary>"}'
   ```

   If the PATCH responds with `{"error": "section_not_found"}` (the
   file pre-dates the convention), retry once with `mode:
   "append_to_file"` and include the section header in the content:

   ```bash
   curl -s -X PATCH http://localhost:8321/api/context/projects/<slug> \
     -H 'Content-Type: application/json' \
     -d '{"mode": "append_to_file", "content": "\n## Log\n- 2026-04-30: <one-line summary>"}'
   ```

   For a **state change** (e.g. `active → on-hold`, milestone reached),
   also rebuild the frontmatter `state` field via GET-merge-PUT — the
   frontmatter parser is line-scalar so per-key PATCH is not available.
   Bump `updated` to today on the same write.

   **Cross-path cancellation.** If this existing-match write resolves
   what was previously a "no match" → confirm path (i.e. a confirm row
   was scheduled and the user has since clarified the project is the
   same as an existing one), delete the pending confirm rows before
   completing the write. See §"Reply branches" below.

3. **No match — schedule a confirm DM (do NOT ask inline).**
   The universal "no topic-pivoting trailing question" rule in
   `message.received.dm{,_first}.md` Step 3 forbids appending a
   project-creation ask to a content-rich reply. Instead of inline
   "Create project `<slug>`? (yes/no)" and waiting on the same DM
   turn, schedule a `confirm:` sub-flow row for a natural follow-up
   moment (default: next morning briefing slot, or `<current_time>
   + 4h` if the DM landed well before quiet hours):

   **a. Pre-flight idempotency check.** Compute the dedup_key
   `create_project:<slug>` and ensure no row is already pending
   (Goal 3):

   ```bash
   curl -s "http://localhost:8321/api/schedule?status=pending,running" \
     | jq --arg k "create_project:<slug>" \
         '[.items[] | select(.taskContext.confirm_dedup_key == $k)] | length'
   ```

   If the count is `≥ 1`, a confirm is already queued — do NOT
   schedule a duplicate. Log to today.md `## Agent Log` and proceed:
   ```
   - HH:MM [confirm] skipped create_project:<slug>: row already pending
   ```

   **b. Schedule the confirm.** Use the shape documented in
   `scheduled.dm.md` §"Confirmation follow-up":

   ```bash
   curl -s -X POST http://localhost:8321/api/schedule \
     -H 'Content-Type: application/json' \
     -d @- <<JSON
   {
     "time": "<next morning-briefing slot, or current_time + 4h — ISO 8601 with offset>",
     "taskType": "dm_session",
     "description": "confirm:create_project:<slug> — track <paraphrase> as a project?",
     "tier": "medium",
     "taskContext": {
       "scheduledBy": "dm_handler.project_creation_gate",
       "sub_flow": "confirm",
       "confirm_id": "<short uuid v4 first 8 chars>",
       "confirm_dedup_key": "create_project:<slug>",
       "confirm_hint": "create project \"<slug>\"? (origin: <one-line paraphrase of user's DM>)",
       "confirm_recent_window_hours": 24,
       "confirm_attempt": 1,
       "confirm_max_attempts": 2,
       "confirm_defer_count": 0,
       "confirm_max_defers": 3,
       "confirm_decline_marker": {
         "path": "agent/journal.md",
         "section": "declined_intents",
         "match": "create_project:<slug>"
       },
       "confirm_slot": {
         "path": "projects/<slug>.md"
       },
       "importance": "low"
     }
   }
   JSON
   ```

   The `confirm_slot.path` (just the file path, no section / anchor)
   makes the fire-time slot-filled probe abort if the project file
   already exists by the time the confirm fires — covering the case
   where the user volunteers an affirmative shape between scheduling
   and fire.

   **c. Do NOT inline-ask.** The DM reply must remain in the user's
   thread per the universal rule. The confirm sub-flow will surface
   the question at the next natural moment. Silently inferring a
   slug and writing without confirmation remains forbidden.

4. **On confirmed creation → PUT the file.** Required + conventional
   frontmatter and an H1:

   ```bash
   curl -s -X PUT http://localhost:8321/api/context/projects/<slug> \
     -H 'Content-Type: application/json' \
     -d @- <<'JSON'
   {"content":"---\ntype: project\nslug: <slug>\nstate: active\nowner: shared\nstart: 2026-04-30\nupdated: 2026-04-30\n---\n# <Title>\n\n## Log\n- 2026-04-30: created via DM — <one-line origin>\n"}
   JSON
   ```

   Add `due`, `stakeholders`, `next_milestone`, `tags` only when the
   user supplied them. Do not invent values.

5. **Reply branches — how the user's response to a scheduled confirm
   is handled.** When the confirm sub-flow fires (`scheduled.dm.md`
   ## Confirmation follow-up) and the user replies, the reply routes
   through `message.received.dm.md` as usual; the dispatcher injects
   `<conversation_history>` so the agent sees both the confirm DM and
   the user's reply in the same turn. This gate is the writer for all
   three branches; every branch is REQUIRED.

   - **Affirmative** — user gave a clear positive answer to the
     confirm question. Examples: *"yes"*, *"go ahead"*,
     *"track it as X"*, *"sounds good"*, *"please do"*. Match on
     intent, not surface vocabulary — recognise the same shape in
     any language the user writes in. Execute the "On confirmed
     creation → PUT the file" path in Step 4. Then run
     §"Cross-path cancellation" below (delete any sibling confirm
     rows with matching `confirm_dedup_key` so a parallel queued
     row does not re-fire).

   - **Counter-proposal** — user supplied new info ("call it
     `la-pm` instead", "actually make it the syllabus dossier",
     "rename it to `la-pm`").
     Use the user's wording, not your original paraphrase:
     re-compute the slug from the corrected wording, PUT the file,
     then cancel pending confirm rows whose `confirm_dedup_key`
     matches **either** the original or the new slug:
     - `create_project:<original-slug>` — the chained-fire successor
       inherits the original key, so this is the primary sweep.
     - `create_project:<new-slug>` — a separate gate fire from an
       earlier DM may have queued a confirm with the new slug (e.g.
       the user previously paraphrased the same project differently
       and that fire's confirm has not yet aborted). The fire-time
       `slot-filled` probe would catch this (the project file now
       exists), but a symmetric sweep here saves a wasted session.

     Run the §"Cross-path cancellation" loop twice — once with each
     key — or merge the two `select`s in jq.

   - **Decline** — user wrote a clear negative answer to the
     confirm question.

     Counts as decline: *"no"*, *"don't bother"*, *"not now"*,
     *"later"*, *"skip it"*, *"forget it"*, *"drop it"*.

     Does NOT count as decline (treat as ambiguous → no DM action
     this turn, marker NOT written, sweep NOT run; the chain's
     softened re-check will handle it):
     - non-answer continuations: *"hmm"*, *"not sure"*, *"I don't
       know"*
     - questions back to the agent: *"why are you asking?"*,
       *"what would that involve?"* — these are clarification
       requests, not declines

     The examples are English for prompt clarity only; recognise
     the same shapes in any language the user writes in. On a true
     decline, do NOT write the project file. Two mandatory writes:

     a. **Write the decline marker** to
        `agent/journal.md ## Declined Intents`. Three cases — file
        missing entirely, file present but section missing, file +
        section both present — are handled in one read-then-branch
        sequence:

        ```bash
        # 1. GET. HTTP 404 means the journal file does not yet exist.
        body=$(curl -sS -w '\n%{http_code}' "http://localhost:8321/api/context/agent/journal")
        status=$(printf '%s\n' "$body" | tail -n1)
        content=$(printf '%s\n' "$body" | sed '$d' | jq -r '.content // ""' 2>/dev/null)

        marker_line='- 2026-05-12 [create_project:<slug>] user declined inline (DM)'

        if [ "$status" = "404" ]; then
          # Case A — file missing. CREATE_ONLY_PUT is enabled for
          # agent/journal, so PUT creates the file in a single call.
          # Include both the H1 and the Declined Intents section.
          curl -s -X PUT "http://localhost:8321/api/context/agent/journal" \
            -H 'Content-Type: application/json' \
            -d "$(jq -n --arg m "$marker_line" '{content: "# Agent Journal\n\n## Declined Intents\n\($m)\n"}')"
        elif printf '%s' "$content" | grep -q '^## Declined Intents'; then
          # Case B — file + section present. Append a bullet to the
          # existing section.
          curl -s -X PATCH "http://localhost:8321/api/context/agent/journal" \
            -H 'Content-Type: application/json' \
            -d "$(jq -n --arg m "$marker_line" '{section:"declined_intents",mode:"append",content:$m}')"
        else
          # Case C — file present but section missing. append_to_file
          # adds the section header + bullet to the end of the file.
          curl -s -X PATCH "http://localhost:8321/api/context/agent/journal" \
            -H 'Content-Type: application/json' \
            -d "$(jq -n --arg m "$marker_line" '{mode:"append_to_file",content:"\n## Declined Intents\n\($m)\n"}')"
        fi
        ```

        Use today's date (resolve via `<current_time>`) for the
        marker line.

     b. **Cancellation** — see §"Cross-path cancellation" below.
        The decline must also delete any pending confirm rows with
        the matching `confirm_dedup_key`, otherwise the chained-fire
        successor will re-ask 24h later despite the explicit "no".

   The decline marker is what the next DM-intent detection (Step 1
   above) consults — without it, the next time the user mentions LA
   PM master's, this gate would compute the same slug, see no
   existing project, and schedule another confirm. The marker is
   how Goal 3 ("never ask the same question twice") survives across
   sessions.

   **Decline-marker reversal.** When the user later volunteers an
   unambiguously affirmative shape ("OK now let's start that LA
   project after all", "actually go ahead and track LA PM") — either
   inline in a fresh DM (the carve-out in Step 1) or as a reply to a
   confirm DM — run this recipe instead of skipping:

   1. GET `agent/journal.md`, parse the `## Declined Intents`
      section, drop the line whose bracketed dedup_key matches
      `create_project:<slug>`, and PATCH the section with
      `mode: "replace"` carrying the rebuilt body (the other lines
      preserved byte-for-byte). If the rebuilt section is empty,
      replace with the empty string — `mode: "replace"` accepts an
      empty `content` and leaves the heading in place.
   2. Proceed with Step 4 (PUT the project file).

   Without the reversal, a previously-declined project would stay
   dormant forever.

   **Cross-path cancellation (required for affirmative,
   counter-proposal, and decline branches).** When this gate
   commits durable state via ANY of the three branches above, sweep
   pending confirm rows with the same dedup_key so a queued
   successor does not re-fire:

   ```bash
   curl -s "http://localhost:8321/api/schedule?status=pending,running" \
     | jq -r --arg k "create_project:<slug>" \
         '.items[] | select(.taskContext.confirm_dedup_key == $k) | .id' \
     | while read -r id; do
         curl -s -X DELETE "http://localhost:8321/api/schedule/$id" >/dev/null
       done
   ```

   Apply this after the affirmative write, after the counter-proposal
   write (with the ORIGINAL slug, not the corrected one), and after
   the decline marker write. The cost is one GET plus zero-to-one
   DELETE per write — bounded by "gate wrote something", which is
   rare relative to inbound DM volume.

**Slug grammar (convention only — no API-level validation today):**
- match `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (or a single `[a-z0-9]`)
- ≤ 64 chars
- equal to the filename stem
- avoid the reserved stems `_index`, `_active`

The context API does not currently reject malformed project slugs, so
the agent is the gate. A non-conforming slug will be written as-is and
later cause friction with the Obsidian Bases view (`_active.base`).

**Tie-breakers:**
- *Project AND long-horizon* — both can apply. A new project with a
  dated milestone gets a `projects/<slug>.md` AND a roadmap entry.
  Run both flows in the same turn; reuse the slug across them where
  natural so the user can correlate the two.
- *Project AND user fact* — write the project state; do NOT also
  write to `user/*.md` unless the message conveys a separate
  identity / preference fact.
- *Project AND management policy* — if the user's wording is "from
  now on, when X happens to project Y, do Z", that's a durable rule
  → `management-policy` skill, not this section. The policy file's
  `linked.dossier` may still point at a `projects/<slug>.md`.

**What this section does NOT cover:**
- Inbox-derived project creation — that path runs in
  `routine.morning_routine.md` Step 4 against `inbox/*` source files
  with a different file-move semantic; do not duplicate it here.
- Roll-off / archive — when a project ends, flip `state: archived`
  via GET-merge-PUT; do not delete the file. The `_active.base`
  Obsidian view filters by `state`.
