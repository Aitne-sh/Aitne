{context}

## Task: Morning Routine — Stage A (today.md synthesis)

You are Stage A of the 04:00 morning-routine pipeline. Stage B
(`routine.morning_routine_journal`) is running in parallel and owns
`daily/<yesterday>.md` end-to-end — do **not** write that file. Your
scope:

- §5.9 Steps 1-4, 6, 6b, 7, 7.5, 8 — today.md, roadmap maintenance,
  schedule fan-out, profile-question mirror, user-editable checks.
- A single structured self-report at the end (Step 9 is daemon-owned;
  you patch metadata, the daemon writes `journal/agent.md`).

Follow the `context` skill for section formats and entry shapes — this
prompt owns the workflow; the skill owns the schema.

> **First-run detection.** When `<yesterday>` is **absent** from your
> prompt context, this is the first morning routine after setup — no
> prior agent-day exists yet. Branches marked **first-run** below apply;
> branches marked **recurring** are skipped.

The "Vault review context" block appended to this prompt includes
`context-index.md` and `knowledge/dossiers/morning.md`; consult it during context
gathering and update the dossier's Open items / Last run before
finishing. Writes to `knowledge/dossiers/<flow>.md` MUST preserve the existing
YAML frontmatter block; prefer `PATCH` with a section target, and on
`PUT` keep the frontmatter and only refresh `updated:` — writes that
drop the frontmatter are rejected with 422.

Global rules (apply at every step):
- Do **not** add meta-maintenance tasks about context files, setup
  completion, or placeholder cleanup (for example, "initialize context
  files") to User Tasks or Handoff, whether carried from yesterday or
  newly discovered, unless the user explicitly asked to track them.
- If `<today_write_lock_id>` is present, every PUT/PATCH to
  `/api/context/state/today` must send header `X-Lock-Id: <today_write_lock_id>`.
- Silent-by-default: your final text is agent-internal. User
  notifications require an explicit `POST /api/notify`.
- Stage B owns `daily/<yesterday>.md`. You MUST NOT write any
  `daily/*.md` file from this session — Step 5 is delegated. The
  daemon's parent audit row gates on YOUR success + today.md health,
  so a Stage B failure does not stop the day from "opening".

### Step 1 — Read handoff and derive day-type

1. **Read the handoff.** When `<handoff_parsed>` is in your prompt
   context, use it verbatim — `<tomorrow>` items feed today's User
   Tasks / Agent Notes, `<later>` items carry into the new `state/today.md`
   ## Handoff, and `<item>(none)</item>` means the section is empty.
   When `<handoff_parsed>` is absent: parse `<yesterday>` ## Handoff
   inline if `<yesterday>` is present; otherwise (first-run) treat
   both lists as empty and Step 6 initialises ## Handoff to `- (none)`.

2. **Recurring (`<yesterday>` present):** Mark `<yesterday>` ## Agent
   Plan rows that did not fire. The daemon rotated `state/today.md →
   yesterday.md` at the 04:00 day boundary, so every `- [ ] HH:MM …`
   row in `<yesterday>` ## Agent Plan is past — the row's intended
   user-facing moment has elapsed. Flip each such row to
   `- [x] HH:MM … (did-not-fire)` via PATCH `/api/context/state/yesterday`,
   `section=agent_plan`, `mode=replace`, and append one
   `- HH:MM [agent_plan] <action> — did-not-fire` line per flipped row
   to `<yesterday>` ## Agent Log (PATCH `section=agent_log`,
   `mode=append`), where `HH:MM` is the **original row's planned time**
   (not the current wall-clock; the entry is anchored to the gap, not
   to when you logged it) and `<action>` is the row's action text —
   the segment between the timestamp and the `[category]` tag, e.g.
   for `- [ ] 10:00 Send meeting pre-brief [work] →DM` the log line is
   `- 10:00 [agent_plan] Send meeting pre-brief — did-not-fire`. The
   today-write-lock only gates `/api/context/state/today`, so NO `X-Lock-Id`
   header is needed on either yesterday.md PATCH. Skip this substep
   entirely when `<yesterday>` ## Agent Plan has no `[ ]` rows.

   **Section-body-rebuild discipline** (applies to the
   `section=agent_plan` PATCH). LLM rebuilds silently drop lines far
   too easily. Before the PATCH:
   - GET the current `## Agent Plan` body fresh.
   - Enumerate kept lines (every `- [x]` row, verbatim) vs. mutated
     lines (each `- [ ]` flipped to `- [x] … (did-not-fire)`). Write
     the keep-list in your reasoning before constructing the new body.
   - The new body equals `keep-list + mutated lines`, byte-for-byte
     for kept lines. Do NOT paraphrase, reformat, drop, or reorder
     sibling rows.

   Do NOT retroactively execute the flipped actions — the user-facing
   moment has passed; logging `did-not-fire` is the close-the-loop
   contract. Note any genuine anomalies (e.g. the row's matching
   scheduled task was mid-execution when the daemon crashed) in
   Step 9's `anomalies` array rather than re-firing here.

   **First-run (`<yesterday>` absent):** Skip this substep — there is
   no prior Agent Plan to reconcile.

3. Derive today's day-type header per the today skill "Header line —
   day-type filter". Read `<user>` ## Notification Preferences for the
   matching policy. The resulting line 2 of `state/today.md` is load-bearing
   — every downstream event parses it. Remember the chosen day-type
   string — Step 9 reports it via `metadata.dayType`.

> **Date reference for today.md.** Take the H1 date from
> `<current_agent_day date="…" weekday="…" />` in your prompt context,
> not from `<current_time>`. The two diverge between local midnight
> and `boundary_hour:00` local; the daemon validates line 1 against
> `<current_agent_day>` and rejects mismatches with 422. The morning
> routine prepares the agent-day in progress — never tomorrow.

### Step 2 — Sync external sources (apply the day-type filter at read time)

4. Mail, Calendar, and Notion acquisition. The pre-pass fetcher
   session (`routine.fetch_window`) ran ahead of you and posted a
   `<fetch>` row's worth of observations for every active mail /
   calendar / notion integration. Calendar windows are pre-fetched
   ONLY for non-direct modes (delegated / native); direct-mode
   calendar data is still inlined into `<calendar_events_7d>` by
   ContextBuilder. The `<fetch_report>` block injected ahead of this
   body tells you the pre-pass status:

   - `status="success"` or `"partial"` → freshly-fetched rows are
     visible in `/api/observations?pending=true`. Trust the table.
   - `status="failed"` → the pre-pass either crashed or its output
     was unparseable. Pending observations from prior ticks may still
     be present; treat the table as best-effort and skip integration
     sections whose source_prefix returns nothing.
   - `status="skipped"` → no integration was active for this routine
     this tick; mail / notion sections are no-ops for this run.

   Then drain pending observations and apply category / focus filtering:

   a. **Mail observations**:
      `GET /api/observations?pending=true&source_prefix=gmail:,outlook_mail:&limit=30`.
      Classify each per the `mail` skill's category taxonomy. Drop any
      whose day-type focus is `off`. When `summary_text` is NULL (the
      async summarizer has not drained yet) fall back to a one-line
      snippet from `payload.raw` (subject + from). Mail data arrives
      here regardless of integration mode — the pre-pass partial
      handled the direct / delegated-same / delegated-cross / native
      wire surface for you.

   b. **Notion observations**:
      `GET /api/observations?pending=true&source_prefix=notion:&limit=20`.
      Use for project / decision context only. Do NOT graduate Notion
      edits into User Tasks unless the user explicitly tagged the entry.

   c. **Calendar context** is already injected as `<calendar_events_7d>`
      (multi-provider) ahead of this prompt — reference the block
      directly in Step 6 (today.md generation). Mode-aware shape:
      direct providers carry inline events; non-direct providers
      (delegated / native) carry a hint pointing at
      `/api/observations?source_prefix=google_calendar:,outlook_calendar:`
      because the pre-pass already POSTed events there. Read the
      observations table verbatim for non-direct providers — do NOT
      re-drive the connector yourself.

   Skip the entire step when no integrations are active and no mail /
   notion observations are pending.

5. Source-of-Truth tasks: read `<management_rules>` ## Source of Truth
   → Tasks, call the matching endpoint, drop filtered-off items before
   merge. Skip if no external source is configured.

6. Roadmap ## Agent Action Plan — process items dated today or overdue
   (without a `completed` Preparation Timeline row). Drop items whose
   category focus is off, then:
   - `[notify]` → one row in `state/today.md` ## Agent Plan (registered in
     Step 7 below).
   - `[today]` → collect for `state/today.md` ## User Tasks.
   - `[check]` → one row in ## Agent Plan with trigger `check-in`
     (registered in Step 7 below).
   - If a roadmap row includes `[provisional ...]`, copy that tag and
     its meaning into the eventual scheduled `taskDescription` so
     `scheduled.task.md` frames the first contact as a confirmation
     question, not a directive.
   - Mark processed roadmap rows complete via `PATCH /api/context/plans/roadmap`,
     `section=agent_action_plan`, `mode=replace`, rewriting the exact
     row from `- YYYY-MM-DD [tag]: ...` to
     `- completed <today>: YYYY-MM-DD [tag]: ...`. Keep the entry ID
     marker and all existing completed rows byte-for-byte.

   Then generate **look-ahead entries** for tomorrow → +3 days by
   cross-referencing unprocessed roadmap items against
   `<calendar_events_7d>`. These go into `state/today.md` ## Agent Notes
   using the skill's "Agent Notes flavor 1: Look-ahead checklist"
   format (`- [ ] (HIGH/MID/LOW) ...`). Skip this step entirely if no
   today-items and no look-ahead items exist.

   **First-run note:** the roadmap may still be the setup-wizard
   skeleton carrying `_(Not yet configured)_` placeholders. In that
   case there are no Agent Action Plan rows to process; this step is
   a no-op until Step 6b populates the roadmap inline.

### Step 3 — Review overnight user-originated observations

7. Call `GET /api/observations?pending=true&actor=user` (observations
   skill). This is the **user-actor** complement to Step 2 — mail /
   notion rows posted by the pre-pass / partials carry `actor=agent`
   and have already been folded in. Step 3 picks up anything the user
   themselves changed overnight (Obsidian edits, manual file drops,
   git commits) that the daemon recorded under `actor=user`. Fold
   only meaningful changes into the `state/today.md` draft you're building,
   respecting the day-type filter.

### Step 4 — Inbox triage (B-007 §5.9 Q5 case A)

8. `GET /api/context/list/inbox` to enumerate pasted memos. For each
   file:
   - `GET /api/context/inbox/<file>` to read the body, then classify:
     **project**, **user**, **memo**, **task**.
   - Integrate into the right target:
     - existing project → append to `projects/<slug>.md` (notify tier).
     - new-project shape → DM to confirm *"create project `<slug>`?"*
       and wait for reply before creating the file.
     - New `projects/<slug>.md` files must include YAML frontmatter:
       `type: project`, `owner: shared`, `updated: YYYY-MM-DD`, then
       an H1.
     - user dictionary (people / health / goals / …) → append to the
       matching `user/<area>.md`.
     - date-bound memo → summarize into `state/today.md` ## Agent Notes.
     - unclassifiable → DM the user an excerpt asking what to do;
       leave the file in `inbox/` for next pass.
   - After integration, move the original: (a)
     `PUT /api/context/state/scratch/inbox-YYYY-MM-DD-<orig-slug>.md`
     with the original body, then (b)
     `DELETE /api/context/inbox/<file>` to remove the source. The
     30-day retention on `state/scratch/` is a convention for now —
     no sweeper exists yet.
   - **High-risk triggers — DM for confirmation before writing:**
     new project creation, wholesale overwrite of `identity/profile.md`,
     financial or health data with a numeric impact. The agent's own
     judgment is the gate — call `POST /api/notify` with the proposed
     change and wait for confirmation; don't auto-write. Increment
     your running `inboxStats.dmConfirmsSent` counter (reported in
     Step 9).
   - **Hard stop (never write)** — if the memo contains anything that
     looks like a credential, password, API key, or private token, do
     NOT write it to any context file. Log one line to ## Agent Log
     (`- HH:MM [inbox] skipped <file>: secret suspected`), leave the
     source file in `inbox/` for the user to handle, and move on.
     Increment your running `inboxStats.secretsSkipped` counter AND
     append a string to your `anomalies` array
     (`"secret suspected in <file>"`) so the audit trail surfaces the
     skip — `agent_actions.metadata.inboxStats.secretsSkipped` is not
     yet rendered in the daemon-emitted journal bullet. This
     overrides the "DM then proceed" path above — see _safety.md.

   Track counts as you triage so you can report them in Step 9:
   `triaged` (every file you processed), `movedToScratch` (every
   `PUT /api/context/state/scratch/...` you sent), `dmConfirmsSent`
   (every high-risk DM-confirm), `secretsSkipped` (every hard-stop).

### Step 5 — Daily journal synthesis [handled by Stage B]

9. The daily journal author (`routine.morning_routine_journal`) runs
   in parallel with you and owns `daily/<yesterday>.md` end-to-end.
   **Do NOT write `daily/*.md` in this session** — Stage B reads its
   own `<journal_skeleton>` (deterministic frontmatter +
   pre-aggregated facts from SQLite) and authors the body per
   `policies/journal-format.md`. Skip this step entirely. Surface any
   anomalies you spot about yesterday's data (corrupted yesterday.md,
   missing SQLite rows) via the `anomalies` array you write in Step 9.

### Step 6 — Generate new today.md (PUT full replace)

10. Follow the context skill "Structure overview", "Entry formats",
    and "Required sections for full replace" sections for the exact
    schema. The H1 (line 1) MUST be
    `# <current_agent_day.date> (<current_agent_day.weekday>)` exactly
    — the daemon rejects mismatches with 422. No YAML frontmatter on
    today.md. Agent Plan rows MUST match
    `- [ ] HH:MM <action> [work|study|personal|home] →<DM|notify|check-in|wake>`;
    any other category or trigger keyword is rejected and forces a
    retry at medium tier.

    Source → section mapping:
    - ## User Schedule ← `<calendar_events_7d>` (filtered). Write
      `- (calendar unavailable)` when the block has been replaced by
      `<calendar_status>Calendar service not available...</calendar_status>`
      (no active provider) or when every `<provider>` sub-block's
      directive fetch failed for this run.
    - ## User Tasks ← Step 1 handoff `<tomorrow>` (recurring only) +
      Step 2 email actionables + SoT tasks + roadmap `[today]`. Use
      `<active_projects>` for context.
    - ## Agent Plan ← Step 2 `[notify]`/`[check]` rows plus any
      proactive reminders you add (meeting pre-briefs, deadline
      nudges). Every row will be registered in Step 7 in a single
      batch — the Agent Plan contract is defined in the skill's
      "User Tasks vs Agent Plan" section.
    - ## Agent Notes ← Step 2 look-ahead items + date-bound memos
      folded from Step 4 inbox triage.
    - ## Agent Log ← initialize with
      `- HH:MM Morning Routine completed (day-type: …)`. On a
      first-run day, use
      `- HH:MM Morning Routine (initial) completed (day-type: …)`
      so the audit log distinguishes the first agent-day.
    - ## Handoff ← Step 1 `<later>` items (recurring), or `- (none)`
      (first-run, or recurring with no Later items). Drop past dates.

    Track every context-file path you wrote (today.md, roadmap.md,
    yesterday.md, dossiers/morning.md, projects/*.md, …) so you can
    report it via `metadata.filesTouched` in Step 9.

### Step 6b — Roadmap maintenance

11. **Recurring:** Update `plans/roadmap.md` only if a milestone completed
    or shifted today.

    **First-run — populate roadmap.md inline.** On the very first
    morning routine the setup wizard's skeleton roadmap is still in
    place (the `## Annual Goals`, `## Quarterly Focus`, and
    `## Agent Action Plan` sections all contain the placeholder line
    `_(Not yet configured)_`). When *any* of those placeholders is
    still present, the daemon has injected a `<roadmap_skeleton>`
    block carrying pre-aggregated scratch data — Annual Goals
    extracted from `policies/management.md`, active projects + 7-day
    calendar for Quarterly Focus, upcoming `travel_bookings` for
    Preparation Timeline. **Read `<roadmap_skeleton>` first**: use
    its data as the source for your populate, reshape / prune /
    reword as the roadmap.md operator template (and your judgement
    about which projects / events are actually relevant) dictates.
    The skeleton has no byte-for-byte preservation contract — it is
    scratch input, not output. Compose the `## Agent Action Plan`
    section yourself from today's User Tasks + roadmap-relevant
    `agent_schedule` rows (the skeleton deliberately omits this
    section because it ages on the same agent-day cadence as
    today.md). Acquire the cross-request write lock via the skill
    before any `PUT /api/context/plans/roadmap` — the daemon enforces it
    and a missing lock returns 423. If every placeholder has already
    been replaced (rare: a previous first-run completed this step
    then today.md failed, or a manual edit landed), the
    `<roadmap_skeleton>` block may still be injected; fall back to
    the recurring semantics regardless and spot-update only if a
    milestone completed or shifted. Skipping this branch leaves
    roadmap.md as the wizard skeleton — the daemon's
    `isRoadmapStale()` post-hook would then schedule a separate
    `routine.roadmap_refresh` to make it good, but the user would
    see a blank-looking roadmap until that second session lands.
    Doing it inline here is one medium-tier turn instead of two and
    removes ~1–2 minutes of post-setup latency.

### Step 7 — Register schedule (single batch POST)

12. Register every `## Agent Plan` row in **one** call to
    `POST /api/schedule/batch`. Per the `schedule` skill's
    "POST /api/schedule/batch" section, atomic-by-default and each
    row carries a rich `taskContext` so the future
    `scheduled.task` / `scheduled.dm` session has the context it
    needs hours later — the daemon cannot reconstruct it from the
    user-facing Agent Plan line.

    **Per-row composition.** For every `- [ ] HH:MM <action>
    [cat] →<trigger>` line you wrote to ## Agent Plan, compose one
    batch row:

    - `scheduledFor`: ISO 8601 with timezone offset from `HH:MM` +
      today's date.
    - `taskType`: `wake` for `→DM` / `→notify` / `→check-in`
      triggers; `dm_session` for `→wake` triggers that should run as
      an interactive DM.
    - `taskDescription`: self-contained (min 20 chars). Same shape
      as the schedule skill's "Writing a Good Description" — verb +
      object + concrete names. Copy any `[provisional ...]` framing
      from the roadmap row.
    - `taskContext.background` (min 30 chars): why this is being
      scheduled — the trigger (roadmap row, calendar event,
      handoff), and what the future session needs to know upfront
      that it could not derive from today.md alone.
    - `taskContext.expected_output` (min 20 chars): what the future
      session should produce (DM shape, file written, check verdict).
    - `taskContext.references` (optional): stable handles the future
      session can look up (`projects/<slug>.md#section`,
      `calendar:event:<id>`, `journal/daily/YYYY-MM-DD.md#agent-revision`,
      roadmap entry id markers).
    - `taskContext.tone` (optional): tone hint for DM-shaped output.
    - `taskContext.scheduledBy`: `"morning_routine"`.

    Pre-flight dedup per the `schedule` skill's "Before creating —
    dedup pre-check" section: scan `<today>` ## Agent Plan,
    pending+running schedules, recurring rules. Drop any row already
    covered before composing the batch — do not POST it.

    **POST the batch.** Each row carries **either** `tier`
    (`lite`/`medium`/`high`, the default cost knob) **or** `model` (a
    registered id like `claude-opus-4-7`, a legacy alias `sonnet`/`opus`,
    or composite `<backendId>/<modelId>`) — never both. Prefer `tier`;
    only pin `model` for rows that must outlive a `/settings/models`
    re-route (e.g. a row whose `expected_output` depends on Opus-class
    reasoning). Omit both fields to let the dispatcher's process-key
    default decide.

    ```bash
    curl -s -X POST http://localhost:8321/api/schedule/batch \
      -H 'Content-Type: application/json' \
      --json @- <<'JSON'
    {
      "rows": [
        {
          "scheduledFor": "2026-05-15T14:30:00-04:00",
          "taskType": "wake",
          "taskDescription": "Pre-brief the 15:00 standup with the two open Q2 risks.",
          "tier": "medium",
          "taskContext": {
            "background": "User flagged Q2 roadmap risks in yesterday's DM; standup needs the two open items front-loaded so the team aligns before 15:30.",
            "expected_output": "DM with two bullet items + one suggested mitigation each, sent 30 min before standup.",
            "references": ["plans/projects/q2-roadmap.md#open-risks", "calendar:event:standup-2026-05-15"],
            "tone": "concise",
            "scheduledBy": "morning_routine"
          }
        },
        {
          "scheduledFor": "2026-05-15T20:00:00-04:00",
          "taskType": "wake",
          "taskDescription": "Synthesise the Q2 roadmap revision draft based on today's risk discussion.",
          "model": "claude-opus-4-7",
          "taskContext": {
            "background": "User asked at standup for a written revision proposal by EOD; row pins Opus because the draft quality depends on the higher-tier reasoning.",
            "expected_output": "plans/projects/q2-roadmap.md revision section appended with three concrete proposals + rationale.",
            "references": ["plans/projects/q2-roadmap.md"],
            "scheduledBy": "morning_routine"
          }
        }
      ],
      "atomic": true
    }
    JSON
    ```

    Per-row issues (`schedule.model_unknown`,
    `schedule.tier_and_model_conflict`) carry `rowIndex` in the
    `errors[]` envelope; map the index back to your `rows` array,
    fix in place, and resubmit the entire batch (`atomic:true`).
    `warnings[]` may carry `schedule.model_deprecated` —
    persistence still happens; surface the warning in anomalies.

    **Cardinality invariant.** `len(rows POSTed) === len(## Agent
    Plan rows you wrote in Step 6, minus duplicates dropped by
    pre-flight dedup)`. The daemon does NOT enforce this — verify it
    yourself before POSTing. On mismatch, append a string to your
    `anomalies` array
    (`"AgentPlan cardinality mismatch: today.md has N rows, batch
    had M"`) so the audit trail surfaces the gap, and remember the
    POSTed count for Step 9's `metadata.scheduleBatchSize`.

    **Error handling.** A 422 response carries the
    agent-consumable envelope (`{ errors: [...], retryable: true }`).
    Per the `schedule` skill's `## Errors` section, read each
    `errors[].hint`, fix the value at `errors[].field`, and POST the
    full body again — `atomic:true` means no rows committed, so
    resubmit the entire batch. Do not retry against a different
    field path; do not loop more than twice (after two failed
    attempts append a string to your `anomalies` array and continue
    — Stage B and Step 9 still need to run).

> **Morning briefing scheduling moved.** The morning briefing is no
> longer registered here. It is a `recurring_schedules` row
> (`task_type='dm_session'`, `task_context.sub_flow='morning_briefing'`)
> created at setup completion and reconciled daily by the daemon. The
> firing session runs under the `conversational` profile via the
> `scheduled.dm.md` task-flow. See SCHEDULED-DM-IMPLEMENTATION-PLAN.md.

13. **First-run only — ensure the daily morning briefing recurring
    schedule exists.** The setup wizard's
    `ensureMorningBriefingRecurring`
    (`packages/daemon/src/api/routes/setup.ts`) normally seeds this
    row at first save-rules, so the daily fire path is daemon-owned
    and the description is hardcoded. The check below covers the
    rare case where setup completed without the seeder (legacy
    setup, partial DB restore).

    Skip this step on recurring days — the row already exists.

    a. **Pre-flight.** `GET /api/recurring-schedules?enabled=true`
       and scan for an item with `taskType === "dm_session"` AND
       `taskContext.sub_flow === "morning_briefing"`. If found, skip
       the rest of this step — duplicate insertion would cause
       double daily fires. Log one line to `## Agent Log`:
       `- HH:MM [morning_routine] morning briefing recurring already seeded`.

    b. **If absent, register via `POST /api/recurring-schedules`**
       (NOT batch / not `POST /api/schedule`) with this body:

       ```json
       {
         "taskType": "dm_session",
         "description": "morning briefing — daily summary",
         "recurrenceRule": {
           "frequency": "daily",
           "time": "<quiet_hours_end or 08:00>",
           "timezone": "<user timezone from <settings primary_timezone> or system default>"
         },
         "taskContext": {
           "sub_flow": "morning_briefing",
           "pin_to_quiet_hours_end": true
         }
       }
       ```

       The `dm_session` task_type + `sub_flow=morning_briefing` is
       the activation key the daemon's scheduler keys off to emit a
       `scheduled.dm` event. Description ≥ 20 chars per the schema;
       `"morning briefing — daily summary"` matches the wording the
       daemon's seeder uses verbatim.

    Do **not** add a one-off `## Agent Plan` row for today's
    briefing here. The recurring-schedule reconciler materialises
    today's `agent_schedule` row automatically from `next_run_at`;
    hand-seeding would duplicate. Do **not** send the briefing
    yourself from this run — this runs during quiet hours.

### Step 7.5 — Profile-interview queue (latent, two-phase)

Use the **user-interview** skill. Phase (a) ALWAYS runs (it is what
keeps today.md's ## Agent Notes mirror in sync across day boundaries,
since today.md is PUT-replaced fresh each morning); phase (b) only
runs when there is no open question.

#### Step 7.5a — Mirror existing latent entries to today.md (always)

GET `state/profile-questions.md ## In Progress`. For every entry
whose state is `latent` (NOT `asked` — those have already been
answered or will be cleaned up by the sweep), append one line to
`state/today.md` `## Agent Notes` using the **today** skill's "Latent
profile question" Agent Notes flavor:

```
- Profile question (latent): <id> — wait for natural opportunity
```

This is the only writer of the `Profile question (latent):` line.
Without it, a row that stays latent across multiple days disappears
from today.md after day 1's PUT-replace and the DM-handler /
morning-briefing opportunity checks lose their visible cue.

#### Step 7.5b — Pick a new question (conditional)

Skip phase (b) entirely if any of:
  (a) `## In Progress` is non-empty (a prior latent / asked entry is
      already open — we hold to the 1-question-at-a-time invariant).
  (b) The user has not sent a DM in the last 24h (no point if
      they're absent).
  (c) Day-type focus for `[personal]` on line 2 of `<today>` is `off`.
  (d) `## Pending` is empty.

Otherwise, walk Pending rows in priority order (HIGH → MID → LOW,
then file order). For each candidate:
  - If the row carries `<!-- last_attempted=YYYY-MM-DD -->` within
    the last 7 days, skip — cooldown.
  - GET `/api/profile-questions/slot-filled?path=<target>&section=<section?>&anchor=<anchor?>`
    for the row. If `filled: true`, the slot was filled since the
    last sweep — tick the row `[ ]` → `[x]` (read-rebuild + replace),
    append `- [x] <today> → <id> (reconciled:morning)` to
    `## Answered`, continue to the next candidate.
  - Otherwise this is the chosen row. Stop walking.

If a row was chosen:

1. PATCH `state/profile-questions.md ## In Progress` (read-rebuild +
   replace) — add a single entry. The `since=<today>` field is
   load-bearing for the evening sweep's 3-day fallback computation:
   ```
   - <id> :: state=latent :: since=<today>
   ```
2. PATCH `state/today.md ## Agent Notes` (mode=append) — same flavor as
   phase (a):
   ```
   - Profile question (latent): <id> — wait for natural opportunity
   ```

**Do NOT register a `POST /api/schedule` (single OR batch) for this
row.** Latent rows are NOT scheduled DMs — they wait for a natural
opportunity (DM topic match or morning briefing piggyback). The
fallback DM path is owned by the evening sweep (Operation 5B), not
the morning routine.

### Step 8 — Extension checks from routines/morning.md

14. The `Morning routine checks` policy block above is the
    user-editable extension surface. Execute any check listed there
    that is **not already covered by Steps 1-7**. User-added entries
    typically carry an `**Added: YYYY-MM-DD by user via DM**` line —
    those are your target. Remember the short label of every check
    you executed (e.g. `"water bottle filled"`, `"calendar synced"`)
    — Step 9 reports them via `metadata.morningChecks`.

### Step 9 — Self-report structured metadata (single PATCH)

15. The daemon's `AgentJournalAppender` writes the morning-routine
    paragraph to `journal/agent.md` from **structured metadata you
    patch onto your own `agent_actions` row** — no LLM final-text
    parsing. Use the `agent-actions` skill's "PATCH /api/agent-actions/self"
    endpoint to publish the metadata exactly once near the end of
    your turn, after every other side-effect has settled:

    ```bash
    curl -s -X PATCH http://localhost:8321/api/agent-actions/self \
      -H 'Content-Type: application/json' \
      --json @- <<'JSON'
    {
      "metadata": {
        "dayType": "weekday",
        "anomalies": ["pre-pass partial (gmail)"],
        "filesTouched": ["context/today.md", "context/roadmap.md"],
        "inboxStats": {
          "triaged": 4,
          "movedToScratch": 4,
          "dmConfirmsSent": 1,
          "secretsSkipped": 0
        },
        "morningChecks": ["water bottle filled", "calendar synced"],
        "scheduleBatchSize": 3
      }
    }
    JSON
    ```

    Field shapes (see the `agent-actions` skill `## Metadata shape`
    table for the full contract):

    - `dayType` — the string you derived in Step 1.3 (the second
      line of today.md is the authoritative form).
    - `anomalies` — `string[]` of short English notes. Empty array
      when none. Cover at minimum: secret-suspected hard stops
      (Step 4), did-not-fire mid-execution anomalies (Step 1.2),
      schedule batch retries (Step 7), AgentPlan / batch cardinality
      mismatches, Stage B-visible data corruption you spotted.
    - `filesTouched` — `string[]` of every `/api/context/*` path you
      wrote or patched during this run. Include `context/state/today.md`,
      `context/plans/roadmap.md` (if updated), `context/knowledge/dossiers/morning.md`,
      `context/state/yesterday.md` (if you patched did-not-fire rows),
      `context/plans/projects/<slug>.md` (if Step 4 created or appended to
      one), `context/identity/<area>.md`, `context/state/profile-questions.md`
      (if Step 7.5b chose a question), `context/state/scratch/...`
      (one entry per inbox file moved).
    - `inboxStats` — running counts from Step 4. All keys integers
      ≥ 0. Emit `{0,0,0,0}` when Step 4 was a no-op (empty inbox).
    - `morningChecks` — `string[]` of short labels for every Step 8
      extension check you executed. Empty array when there were
      none. The daemon renders the list joined with `, ` into the
      `Checks from routines/morning.md:` bullet.
    - `scheduleBatchSize` — the number of rows you POSTed to
      `/api/schedule/batch` in Step 7. `0` when no rows were
      registered (cardinality contract: this should equal the
      number of `## Agent Plan` rows minus dedup-drops).

    A single PATCH per turn. Repeat PATCHes shallow-merge (later
    keys win), but the daemon expects one consolidated call so the
    journal entry reads cleanly. The daemon's appender will surface
    these fields in `journal/agent.md` on a recurring day as:

    ```
    ## YYYY-MM-DD morning routine
    - Day-type: <dayType>
    - Journal: journal/daily/YYYY-MM-DD.md (<N lines, M projects referenced>)
    - Inbox: <triaged> files triaged, <movedToScratch> moved to scratch, <dmConfirmsSent> DM-confirmations sent
    - Checks from routines/morning.md: <morningChecks joined>
    - Anomalies / skipped steps: <anomalies joined or "(none)">
    ```

    On a first-run day (Stage B skipped, no `daily/<date>.md`
    landed) the `Journal:` line becomes
    `- Journal synthesis: skipped (no prior-day data)` automatically
    — the daemon derives the variant from disk state, you do NOT
    need a flag in metadata.

    If the PATCH returns `agent_actions.session_row_not_found`
    (404), the dispatcher has not pre-inserted your in-flight row —
    surface a one-line warning to `## Agent Log`
    (`- HH:MM [morning_routine] agent-self self-report 404 — no in-flight row`)
    and continue. Do NOT block the turn on telemetry, and do NOT
    fall back to writing `journal/agent.md` directly (the daemon
    owns that file in V2; a direct write would race).

    <output_language>english_only — Policy A surface (agent journal,
    parsed log); `<output_language_policy>` carves this out
    explicitly.</output_language>
