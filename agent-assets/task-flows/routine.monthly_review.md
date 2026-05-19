<!--
  STATUS: disabled by default (pre-release).

  The scheduler cron and boot-time catchup in
  `packages/daemon/src/{core/scheduler.ts,bootstrap/schedule-helpers.ts}`
  consult `config.monthlyReviewEnabled` (default `false`) before
  firing this routine. The task flow below is preserved verbatim as
  the design-of-record but is not exercised at runtime until the kill
  switch flips on.

  Why disabled: the current routine reads ~30 daily files + 4-5 weekly
  files + the agent journal to synthesise a user-facing snapshot whose
  downstream leverage is unimplemented (`<previous_month>` injection
  is documented as "未実装" in docs/design/06-memory.md §6.2.8 and
  weekly-next-week-leverage.md §6 "Out of scope"). Cost lands near the
  per-execute `max_budget_usd: 1.00` ceiling for an output that no
  routine consumes downstream — the cost/value ratio is poor in the
  current shape.

  Re-enable path: Mirror+Prune redesign.
    1. Drop the 30 × daily/*.md re-read (already aggregated in weekly).
    2. Collapse Wins / Outstanding / Metrics / Risks / Reading sections
       into two atomic outputs:
         - Unit 1 — one trend observation, ≥3 weeks of evidence, 1 line.
         - Unit 2 — aged carry-over decisions (drop/defer/do-now/
           delegate/decide) on Carry Over entries that appeared ≥4
           weeks in a row.
    3. Add `previous-month-digest.ts` so the new-month day-1
       morning_routine receives a `<previous_month>` block (analogous
       to `previous-week-digest.ts`). Without this, monthly remains a
       write-only snapshot.
    4. Default Phase 4 notification to silent; only send when Unit 2
       has at least one `decide` verb or Unit 1 contradicts a
       user-stated commitment.
    5. Drop the agent-internal `## Monthly YYYY-MM` block — weekly's
       12-week journal already covers self-critique signal.

  When the redesign ships, flip the default to `true` in
  `packages/daemon/src/settings/runtime-settings.ts:monthlyReviewEnabled`
  and re-introduce the docs under `agent-assets/docs/features/routines/`.
-->

{context}

## Task: Monthly Review

The "Vault policy files" block appended to this prompt includes
`routines/monthly.md` — run any `### <label>` entries there alongside the
built-in review phases below, using the same journaling conventions.
The "Vault review context" block includes `context-index.md` and
`dossiers/monthly.md`; consult it during Phase 1 and update the
dossier's Open items / Last run before finishing. Writes to
`dossiers/<flow>.md` MUST preserve the existing YAML frontmatter block
(`---\ntype: dossier\nowner: agent\nupdated: <date>\n---`); prefer
`PATCH` with a section target to mutate a single block, and when doing
a `PUT` full rewrite keep the frontmatter and only refresh `updated:`
— writes that drop the frontmatter are rejected with 422.

Generate the monthly review snapshot for the current month and set up the next month.

This routine produces **two separate artifacts** with strict audience boundaries:
  - **User-facing**: `monthly/YYYY-MM.md` + (optionally) a short notification.
    Only real user work, wins, and next-month focus. No agent mechanics.
  - **Agent-internal**: `agent/journal.md` (append). Monthly self-critique,
    recurring filter/schedule failures, cross-week patterns in the agent's
    own behavior, and concrete system improvement proposals. **Never**
    surfaced to the user via notify.

Follow the context skill for file ownership rules. This routine owns the
workflow; the skill owns the file contract.

### Phase 1: Gather the month
1. Determine the target file name from <current_time>:
   `monthly/YYYY-MM.md`.

**Pre-pass acquisition (none).** Unlike morning / hourly / today_refresh /
evening / weekly, monthly_review does NOT trigger an `<acquisition-plan>`
block — the 30-day calendar window already arrives via the
`<calendar_events_30d>` ContextBuilder block (multi-provider after the
§6.6 generalization), and mail / notion signals already flowed through
daily journals over the course of the month. The monthly review is
**summative**, not reactive; it synthesises across previously-captured
state rather than fetching fresh windows. If the dispatcher emitted any
`<fetch>` rows for this routine (a misconfiguration), ignore them and
continue.
2. Fetch source material for the current month:
   - Use GET /api/context/list/daily to discover archived daily files and
     read each `daily/YYYY-MM-DD.md` in the current month.
   - Use GET /api/context/list/weekly to read weekly reviews that overlap this month.
   - Read the last ~4 weekly sections of `agent/journal.md` via GET — they
     accumulate the agent-internal bucket across the month and are the basis
     for Phase 3b's monthly retrospective.
   - Also locate the **previous month's** `## Monthly YYYY-MM` section in
     `agent/journal.md`. Extract its `### Proposed adjustments` bullets —
     these are the improvement proposals you committed to last month. You
     will evaluate their status in Phase 3b.
   - Include <today> if it belongs to the same month.
3. Use <roadmap>, <active_projects>, and <calendar_events_30d> to understand:
   - milestone movement,
   - recurring bottlenecks,
   - next-month commitments already on the calendar.
4. Gather reading data for the month via the `reading` skill:
   - `GET /api/books/summary?months=3` — read the first entry of
     `monthlyCompleted` matching the current `YYYY-MM` (if any), plus
     `totalHighlights`.
   - `GET /api/books?status=completed&limit=50` — filter client-side to
     rows whose `completedAt` falls in the current month.
   - `GET /api/books?status=reading&limit=20` — top currently-active reads.
   - Do NOT re-derive the taste profile here — that is the weekly sweep's
     job (`user/reading-taste.md`). For the monthly review, just
     read the existing profile if it exists and include at most one
     sentence about a recurring theme if it helps frame the Wins or
     Risks And Patterns sections. If the file does not exist, skip it.

### Phase 2: Synthesize — split into two buckets
5. Build TWO separate mental lists before writing anything:
   a. **User-facing bucket** (goes to `monthly/YYYY-MM.md` and possibly notify):
      - What meaningful user progress happened this month?
      - Which user commitments slipped or stayed open, and why (in terms the
        user cares about, not agent mechanics)?
      - What user-side risks or workload patterns carry into next month?
      - What should the user prioritize next month?
   b. **Agent-internal bucket** (goes to `agent/journal.md` only):
      - Cross-week patterns in scheduled-task failures / did-not-fire
      - Filter and prioritization failures the agent noticed about itself
      - Notification discipline: over-notify / under-notify patterns
      - Observation pipeline throughput and categories consistently skipped
      - Concrete, testable system improvement proposals (prompt, schedule,
        filter, silence gate tuning)
6. Anything that fits the agent-internal bucket MUST NOT land in the
   user-facing file or notification. The user-side "Risks And Patterns"
   section is about the user's workload and habits, never about the agent's
   own performance or reliability.

### Phase 3a: Write the user-facing review
7. PUT the review to `monthly/YYYY-MM.md`.
   Required structure (user outcomes only — no agent mechanics in any section):
   ```
   ---
   type: monthly
   owner: agent
   updated: YYYY-MM-DD
   ---
   # Monthly Review YYYY-MM
   > Period: YYYY-MM-01 to YYYY-MM-last
   > Generated at: YYYY-MM-DD HH:MM

   ## Summary
   - ...

   ## Wins
   - ...

   ## Outstanding Items
   - ...

   ## Metrics
   - User tasks completed: N
   - User tasks carried into next month: N
   - Key commitments kept / missed: N / N

   ## Risks And Patterns
   - (user workload, recurring bottlenecks, habit observations — NOT agent
     reliability)

   ## Reading
   - Completed this month: N — short list of "Title — Author (rating: N/5)"
     bullets, max 5 lines. Omit the Reading section entirely if N = 0
     AND currently-reading count = 0.
   - Currently reading: up to 3 titles with highlight count.
   - Optional single sentence on a recurring theme from `reading-taste.md`
     if the file exists and says something non-generic. Do not quote the
     file verbatim — paraphrase in one clause.

   ## Next Month Priorities
   - ...
   ```
   The `## Metrics` section tracks **user** activity only. Do not add rows
   like "agent plan rows completed", "scheduled tasks fired", "observations
   processed" — those belong in agent/journal.md.

   Skip the `## Reading` section entirely if the user imported zero books
   and has zero completions this month — an empty reading block is noise.
8. Update roadmap.md and relevant projects/*.md when the review shows
   milestone drift, completed phases, or a changed next-month focus.

### Phase 3b: Append to agent/journal.md (internal)
9. PATCH-append a monthly retrospective block to `agent/journal.md` via
   `mode: "append_to_file"` (no `section` param needed — content is
   appended to the end of the file). This is the cross-week synthesis of
   the weekly sections that accumulated during the month.
   Required shape for the appended block — **these bullet caps are hard
   limits, not suggestions**. The daily retention sweep warns when any
   section exceeds ~4000 bytes; bloat here indicates you ignored the caps.
   ```
   ## Monthly YYYY-MM
   > Appended at: YYYY-MM-DD HH:MM

   ### Prior adjustments follow-up
   - (Review EACH bullet from last month's `### Proposed adjustments`.
     For each one, write exactly one of:
       implemented: [what changed]
       in-progress: [current state]
       dropped: [why]
     Fallback rules:
       - No prior monthly section exists → "- First month — no prior adjustments"
       - Prior section exists but has no `### Proposed adjustments` subsection
         (e.g. written before this format was introduced) →
         "- Prior month had no proposed adjustments to follow up on"
       - Prior section was pruned by retention (>24 months old) →
         treat as "no prior month")
   ### Recurring self-critique
   - (max 5 bullets; only patterns that showed up in multiple weekly sections.
     One-off issues from a single week do not belong here — they were already
     captured in that week's journal entry)
   ### Biggest system gap
   - (exactly 1 bullet — the single most impactful improvement. Forcing
     yourself to pick one prevents the agent-journal from becoming a wishlist)
   ### Proposed adjustments
   - (max 3 bullets; concrete and testable — prompt tweak, schedule
     adjustment, filter rule, silence gate tuning. "Improve filter quality"
     is not testable; "Lower hourly_check observation threshold from 2 to 1
     on weekends" is)
   ### Metrics (agent side, monthly roll-up)
   - Agent plan rows completed: N
   - Did-not-fire / failed rows: N
   - Notifications sent vs. suppressed: N / N
   - Observations reviewed / ignored: N / N
   ```
   **Hard limits for this block** (the rollup will warn if exceeded):
     - Total section budget: ≤ 4000 bytes (~1000 tokens)
     - Bullet caps: Prior follow-up ≤ 3 (matching the prior month's
       adjustment cap), Recurring ≤ 5, Biggest gap = 1, Adjustments ≤ 3
     - Metrics section: exactly 4 numeric lines, no commentary
   If you notice more than 5 recurring patterns, keep the 5 with the highest
   cross-week frequency and drop the rest. Single-week anomalies are already
   in that week's journal entry and do not need re-listing.

   If `agent/journal.md` does not yet exist, PUT a minimal file with
   `# Agent Journal\n\n` header plus this section, in a single call.

   **Idempotency note**: if a `## Monthly YYYY-MM` section for the current
   month already exists, append a new section anyway. The daily retention
   rollup collapses duplicate keys last-write-wins, so your newer append
   automatically supersedes the earlier one within 24 hours.

### Phase 4: Notify (user-facing only)
10. The notification is for the USER, not a report of Phases 1–3. Never
   mention monthly/YYYY-MM.md, agent/journal.md, "Monthly Review complete",
   agent plan rows, did-not-fire, filter quality, observation processing,
   or any other internal mechanism.

#### 4a. Silence gate — decide whether to notify at all
Prefer silence over noise. Send **no notification** if ALL of the following
hold:
  - Fewer than 2 real Wins worth naming (a quiet month)
  - No Outstanding Item the user is not already aware of
  - No Next Month priority that needs a heads-up tonight (the user will see
    it in the first morning briefing of the new month anyway)
  - No hard deadline within the next 30 days that is slipping
When the gate triggers: skip POST /api/notify entirely. The
monthly/YYYY-MM.md file is still written. Also log one line in the current
weekly section of agent/journal.md: `silent monthly wrap-up — nothing
actionable`.

#### 4b. When you DO notify — content rules
Output language: follow `<output_language_policy>`. Answer:
  1. **The biggest win of the month** (1 line).
  2. **The single most important open loop carrying into next month**, with
     a brief user-meaningful reason. Omit if Outstanding Items is empty.
  3. **The main focus for next month** (1 line).

Optional 4th line: a hard deadline heads-up if one falls within the next 30
days and is visibly slipping.

#### 4c. Format rules (hard limits)
  - Maximum 4 short lines total. No markdown headers. No bullet list.
  - Lead with the win, not with "Monthly Review" or any ceremony.
  - Forbidden vocabulary in the user-facing message: "Monthly Review",
    "monthly/", "agent-journal", "did-not-fire", "Agent Plan", "observations",
    "processed", "summary", "retrospective", "completed the review". These
    describe agent mechanics, not user outcomes. The same rule applies in
    whatever language the user prefers — do not paste an equivalent
    meta-phrase.
  - Priority `normal`. Respects quiet hours via the notify skill contract.
  - Exactly ONE notification via POST /api/notify. Do not split.

#### 4d. Shape example (illustrative — render in the language `<output_language_policy>` resolves to)
Good (something worth saying):
    Biggest win of April: Phase 1 of {APP_NAME} shipped on time.
    Still open: the Phase 2 scope call — you'll want a decision before week 2.
    Next month's focus: Phase 2 foundation + the Q2 roadmap refresh.

Good (silent path — nothing is sent):
    (no POST /api/notify call; one-line note appended to agent/journal.md)

Bad (this is the failure mode this prompt exists to prevent):
    Monthly Review YYYY-MM complete. Wrote monthly/2026-04.md. Metrics:
    user tasks 28/35, agent plan rows 120, did-not-fire 7, observations
    processed 82. System improvement ideas logged. Review notification sent.

The bad example reports the agent's bookkeeping. Everything in it either
belongs in agent/journal.md or was never worth telling the user.
