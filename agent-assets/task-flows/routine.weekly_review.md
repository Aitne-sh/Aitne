{context}

## Task: Weekly Review

The "Vault policy files" block appended to this prompt includes
`routines/weekly.md` — run any `### <label>` entries there alongside the
built-in review phases below, using the same journaling conventions.
The "Vault review context" block includes `context-index.md` and
`dossiers/weekly.md`; consult it during Phase 1 and update the
dossier's Open items / Last run before finishing. Writes to
`dossiers/<flow>.md` MUST preserve the existing YAML frontmatter block
(`---\ntype: dossier\nowner: agent\nupdated: <date>\n---`); prefer
`PATCH` with a section target to mutate a single block, and when doing
a `PUT` full rewrite keep the frontmatter and only refresh `updated:`
— writes that drop the frontmatter are rejected with 422.

Generate the weekly review snapshot for the current ISO week and prepare next-week priorities.

The `## Carry Over to Next Week`, `## Next Week Focus`, and `## Lessons
for Next Week` sections you write here are not just a snapshot — they
are lifted into **every** morning_routine of the next ISO week (Mon–Sun)
via the `<previous_week>` context block. Treat them as load-bearing
input to next week's daily planning, not as an artifact the user reads
once. Full design: `docs/design/appendices/weekly-next-week-leverage.md`.

This routine produces **two separate artifacts** with strict audience boundaries:
  - **User-facing**: `weekly/YYYY-Www.md` + a short Friday-evening
    notification (default send; narrow silence gate in Phase 4a).
    Only real user outcomes — no agent mechanics, no fabricated
    positivity. Tone: brief, warm, weekend-close.
  - **Agent-internal**: `agent/journal.md` (append). Self-reflection, filter
    quality, system improvement ideas, failed scheduled actions, pipeline
    observations. **Never** surfaced to the user via notify.

Follow the context skill for file ownership rules. This routine owns the
workflow; the skill owns the file contract.

### Phase 1: Gather the week
1. Determine the target file name from <current_time>:
   `weekly/YYYY-Www.md` (ISO week in the daemon timezone).
2. Read the current-ISO-week calendar retrospective. The pre-pass
   fetcher session (`routine.fetch_window`) ran ahead of you and posted
   observations for the `cal_iso_week_to_now` window for every active
   calendar integration (Google + Outlook). That window spans from
   **Monday 00:00 local** of the current ISO week through **now**, so
   the retrospective covers exactly the days the archived
   `daily/YYYY-MM-DD.md` files are keyed on — no rolling drift into
   last week's tail, and no missing today's events. The
   `<fetch_report>` block in your prompt tells you the pre-pass
   status — `success` / `partial` means the table is fresh;
   `failed` / `skipped` means trust nothing newer than the prior tick
   and treat the retrospective as best-effort. The ContextBuilder
   block `<calendar_events_7d>` already covers the forward-looking
   next-7-days view; this step adds the retrospective complement so the
   review surfaces what actually happened this week, not just what's
   coming next.

   Drain pending current-ISO-week observations. The pre-pass posted
   them just now under `pending=true`, so a single bounded fetch is
   sufficient — no `observed_at_after` filter needed:

   ```
   GET /api/observations?pending=true&source_prefix=google_calendar:,outlook_calendar:&limit=200
   ```

   Treat each row's `payload.raw` (`title` / `start` / `end` /
   `attendees` / `status`) as authoritative; cross-reference against the
   daily files in step 3 below to disambiguate attended vs cancelled
   meetings. If a row's `payload.raw.start` falls outside the current
   ISO week (e.g. a stale pending row from an earlier weekly_review
   that never reached the consume step), ignore it for this synthesis
   but still let the consume call sweep it so it doesn't bias next
   week's run.
3. Fetch the source days for the current ISO week:
   - Use GET /api/context/list/daily to discover archived daily files.
   - Read each `daily/YYYY-MM-DD.md` whose date falls in the current ISO week.
   - Include <today> as the in-progress final day. On the Friday-evening
     cron run, the daily archive carries Mon–Thu and `<today>` carries
     Friday-in-progress; Saturday and Sunday have not happened yet, and
     the next morning's `morning_routine` will not have archived
     Friday's daily file yet either. That is the working dataset — do
     not invent Sat/Sun content; the `## Metrics` and `## Period`
     fields below describe this honestly.
4. Use <roadmap>, <active_projects>, and <calendar_events_7d> to understand:
   - which milestones moved this week (cross-reference with Step 2's
     retrospective observations),
   - what remains incomplete,
   - what needs attention next week.

### Phase 2: Synthesize — split into two buckets
5. Build TWO separate mental lists before writing anything:
   a. **User-facing bucket** (goes to `weekly/YYYY-Www.md` and possibly notify).
      Synthesize along **three axes**:
      i.   **Outcomes** — what meaningful user work moved forward this week,
           and which user tasks / commitments slipped or stalled (with the
           reason the USER cares about — "blocked on Sarah's reply", not
           "agent skipped reminder").
      ii.  **Forward items** — what should the user focus on next week, and
           which open loops carry forward. Each carry-over needs the
           one-line reason / blocker that lets the upcoming morning_routine
           judge whether it is still hot.
      iii. **Behavioral lessons** — patterns in *how* the user worked this
           week, distilled into **a concrete forward adjustment** for next
           week. The format is **observation → next-week action**, not
           free-floating commentary. Each line must:
             - Cite evidence from this week's `daily/*.md`,
               `<yesterday_messages>`, or `<calendar_events_7d>` (not
               speculation). If the data does not show a pattern, write no
               lesson — fabrication is forbidden.
             - End in a **testable, specific action** the user could take
               next week. "Focus better" is not testable; "Block Tue/Wed
               9-11 on calendar" is.
             - Stay user-actionable. Agent-side filter-quality observations
               belong in the agent-internal bucket (see (b) below), not
               here.
           Hard cap: 3 lessons. Two is fine; zero is fine. Padding to three
           dilutes the signal that downstream morning_routines act on.
   b. **Agent-internal bucket** (goes to `agent/journal.md` only):
      - Scheduled tasks / reminders that did-not-fire or failed, and any
        pattern behind the failures
      - Quality of the day-type / focus-dimension filter (false positives,
        false negatives)
      - Observation pipeline health (how many observations reviewed vs.
        ignored, any categories consistently skipped)
      - Self-critique: where I over-notified, under-notified, or made a poor
        prioritization call this week
      - Concrete system improvement ideas (tighter silence gates, prompt
        adjustments, missing context features)
6. Anything that fits the agent-internal bucket MUST NOT land in the
   user-facing file or notification. When in doubt about a line item: "would
   the user act on this, or is it a note about how the agent is doing?" →
   agent-internal if the latter.

### Phase 3a: Write the user-facing review
7. PUT the review to `weekly/YYYY-Www.md`.
   Required structure (user outcomes only — no agent mechanics in any section):
   ```
   ---
   type: weekly
   owner: agent
   updated: YYYY-MM-DD
   ---
   # Weekly Review YYYY-Www
   > ISO week: YYYY-MM-DD (Mon) – YYYY-MM-DD (Sun)
   > Evaluated through: YYYY-MM-DD HH:MM (Sat/Sun not yet observed)
   > Generated at: YYYY-MM-DD HH:MM

   ## Highlights
   - ...

   ## Completed
   - ...

   ## Open Loops
   - ...

   ## Metrics
   - User tasks completed: N
   - User tasks carried over: N
   - Key meetings / commitments kept: N

   ## Carry Over to Next Week
   - <Open loop A> — <one-line user-meaningful reason / blocker>
   - <Open loop B> — <one-line user-meaningful reason / blocker>

   ## Next Week Focus
   - <Top priority 1>
   - <Top priority 2>

   ## Lessons for Next Week
   - <observation from this week's data> → <specific next-week action>
   - <observation> → <specific next-week action>
   ```
   The `## Metrics` section tracks **user** activity only. Do not add rows
   like "agent plan rows completed", "scheduled tasks fired", "observations
   processed" — those are agent mechanics and belong in agent/journal.md.

   **`## Carry Over to Next Week`, `## Next Week Focus`, and `## Lessons
   for Next Week` are import-targeted sections** — every morning of the
   next ISO week, `morning_routine` lifts these three sections
   mechanically from this file via the `<previous_week>` context block
   (see `routine.morning_routine.md` "Previous-week leverage" step).
   Treat the contract as load-bearing:
     - **Carry Over** — max **5** bullets. Each must point at a real
       `## Open Loops` entry from this same file (not aspirational items),
       and include a short reason / blocker so next week's morning_routines
       can decide whether the loop is still hot or has been overtaken by
       the week's events. If there are no genuine carry-overs, leave the
       section body empty — the `<previous_week>` renderer surfaces an
       explicit `(none recorded)` placeholder so next week's morning_routine
       sees the same "deliberately none" signal it sees for an empty
       Focus or Lessons section. Do not write `- (none)` (it would be
       extracted verbatim and clash with the placeholder for the other
       two sections).
     - **Next Week Focus** — max **3** bullets, ordered. The "if you only
       did three things next week" list. Each item should be specific
       enough that next week's `today.md` priority selection can use it
       verbatim as a candidate. If next week's focus is unclear from this
       week's data, write fewer items rather than padding to three.
     - **Lessons for Next Week** — max **3** bullets, format
       `<observation> → <specific next-week action>`. Source the
       observations from Phase 2 (a) (iii) "Behavioral lessons" axis.
       Examples that conform:
         - `Tue/Wed deep-work mornings were eaten by ad-hoc meetings → block Tue/Wed 9–11 on calendar`
         - `Email replies started after 14:00 mostly slid to the next day → handle first wave by 11:00`
       Examples that violate (do NOT write these):
         - `Focus more next week` — no observation, no testable action.
         - `Be more disciplined about email` — no concrete adjustment.
         - `Agent over-notified on Tuesday` — agent mechanics; belongs in
           agent/journal.md, never here.
       Zero lessons is acceptable. Padding is worse than silence — the
       morning_routine's only job with a fabricated lesson is to ignore it,
       which trains the loop to ignore real ones too.
     - All three lists are caps, not quotas. Exceeding any signals
       over-promising; the morning_routine cannot productively act on a
       Carry Over longer than 5, a Focus longer than 3, or Lessons longer
       than 3.
     - Section headings must match exactly — the digest extractor is
       header-regex bound. Do not rename, translate, or pluralize.
     - Body bullets are surfaced to the agent in
       `<output_language_policy>`'s body language; the H2 headers
       themselves stay in English per Policy B (skeleton headers fixed,
       prose follows `<settings primary_language>`).
8. If the review reveals roadmap drift or stale project status, update
   roadmap.md and the relevant projects/*.md in the same session.

### Phase 3b: Append to agent/journal.md (internal)
9. PATCH-append a new section to `agent/journal.md` with the agent-internal
   bucket from Phase 2. Use `mode: "append_to_file"` (no `section` param
   needed — content is appended to the end of the file).
   Required shape for the appended block — **these bullet caps are hard
   limits, not suggestions**. The daily retention sweep warns when any
   section exceeds ~4000 bytes; bloat here indicates you ignored the caps.
   ```
   ## Weekly YYYY-Www
   > Appended at: YYYY-MM-DD HH:MM

   ### What worked
   - (max 5 bullets, each ≤ 1 line, concrete and specific — no padding)
   ### What slipped on my side
   - (max 5 bullets; scheduled tasks that did-not-fire, mis-filtered items,
     over-notifications. If none, write a single line: "- nothing notable")
   ### System improvement ideas
   - (max 3 bullets; each must propose a specific, testable change —
     prompt tweak / schedule adjustment / filter rule. "Improve the filter"
     is not testable; "Add Saturday to Weekend day-type default" is)
   ### Metrics (agent side)
   - Agent plan rows completed: N
   - Did-not-fire / failed rows: N
   - Observations reviewed / ignored: N / N
   ```
   **Hard limits for this block** (the rollup will warn if exceeded):
     - Total section budget: ≤ 4000 bytes (~1000 tokens)
     - Bullet caps: What worked ≤ 5, What slipped ≤ 5, Improvement ideas ≤ 3
     - Metrics section: exactly 3 numeric lines, no commentary
   If you have more than 5 notable items in one subsection, keep only the
   top 5 by actionable impact and drop the rest. Do not try to fit
   everything — the monthly review synthesizes across weeks and surfaces
   recurring items anyway.

   If `agent/journal.md` does not yet exist (GET returns 404), PUT a minimal
   file with just `# Agent Journal\n\n` as header and your new section below
   it, in a single call. Do not abort the review.

   **Idempotency note**: if a `## Weekly YYYY-Www` section for the current
   week already exists (e.g. a previous run of this routine today), append
   a new section anyway. The daily retention rollup collapses duplicate
   keys last-write-wins, so your newer append automatically supersedes the
   earlier one within 24 hours. Do not spend tokens trying to locate and
   overwrite the old section in place.

### Phase 4: Notify (user-facing only)
10. The notification is a brief, warm end-of-week touchpoint for the USER
    — not a report of Phases 1–3. Never mention weekly/YYYY-Www.md,
    agent/journal.md, "Weekly Review complete", agent plan rows,
    did-not-fire, filter quality, observation processing, or any other
    internal mechanism.

    The default posture for this notification is **send**. Friday evening
    is a natural touchpoint and the user opted into receiving one. Skip
    only under the narrow silence gate in 4a.

#### 4a. Silence gate — skip only when the week was essentially blank
Send **no notification** only if ALL of these hold:
  - Zero daily files in `daily/` were updated this week, AND
  - No completed user work surfaced in Phase 1 (highlights and completed
    lists in the weekly file would both be empty)
In a normal week — even a low-activity one — notify.

When the gate triggers: skip POST /api/notify entirely. The weekly file
is still written (user can open it on demand). Append one bullet under
agent/journal.md "What worked": `silent weekly wrap-up — quiet week`.

**Silence-path × leverage loop.** A silent-path week still PUTs the
full Phase 3a structure. Carry Over / Next Week Focus / Lessons may be
legitimately empty when the week was blank — leave their bodies empty
(do **not** write `- (none)` placeholders). Next week's morning_routine
will see `<carry_over>` / `<focus>` / `<lessons>` rendered as
`(none recorded)` and skip them silently, which is the correct signal
that the prior week had nothing to lift.

#### 4b. When you DO notify — content rules
Output language: follow `<output_language_policy>`. Compose in this order:

  1. **One concrete win from this week** (1 line). Must name an
     artifact AND either the day it shipped or its concrete current
     state.
       ✓ "the design doc shipped Thursday" (artifact + day)
       ✓ "auth refactor is in review, queued for Monday landing"
         (artifact + state)
       ✗ "solid progress on the auth refactor" (no artifact / day /
         state — would read plausibly in any week)
     If Phases 1–3 supply no concrete artifact + day/state, the
     silence gate in 4a should fire — do not pad with generic praise.

  2. **Optional insight line — default is OMIT.** The canonical correct
     output is **2 lines** (win + weekend close). Include line 2 only
     when ONE of bar (a) or (b) clears unambiguously.

     a. **Personalized pattern** — a real pattern in **this week's**
        data. Must (i) cite specific instances (named tasks, calendar
        entries, daily-file rows), (ii) rest on **≥3 concrete
        instances** within the week (N=1 anecdotes do not qualify),
        (iii) be about the user's behavior or outcomes, not external
        factors.
        ✓ "Worth noticing — every task you started before 10:00 closed
          the same day; the four after-lunch starts mostly slid to
          tomorrow." (two buckets + a count)
        ✗ "Your mornings seemed more productive than afternoons this
          week." (vague, no count — true of any week)

     b. **Academic finding** — a well-known finding from psychology,
        behavioral economics, cognitive science, or productivity
        research that maps **specifically** to a concrete thing the
        user did this week. **If you reach for hedge phrasing —
        "studies suggest…", "research often shows…", "it is said
        that…" — you are not confident the finding is real; omit.**
        Match a specific week activity, not a generic proverb.
        Register: "Worth knowing…" not "You should…" (advice
        forbidden).
        ✓ "Worth knowing: deep-work researchers find three consecutive
          focused days tend to outperform five scattered ones for
          shipping work like this."
        ✗ "Worth noticing — small, consistent efforts compound over
          time." (proverb, no named research area, generic)

     **No-fabrication rule** (both bars):
       - Numbers, percentages, deltas, week-over-week comparisons must
         appear **literally in the data**. "30% harder", "doubled
         throughput", "twice the rate" — forbidden unless real counts
         you can point at.
       - Vague intensifiers are padding, not insight: "crushed it",
         "big momentum", "small efforts compound", etc. **Paste-test**:
         if line 2 could fit any user's review and still read as
         plausible, delete it.
       - **First 2–3 weeks of operation** (few prior `weekly/*.md`):
         skip line 2 unconditionally — insufficient data for patterns,
         premature citations erode trust.

  3. **Weekend close** (1 line) — calendar-aware via
     <calendar_events_7d>:
     - Non-trivial commitment this weekend (work event, deadline,
       exam, interview): brief specific encouragement tied to it
       — e.g. "Good luck with the API review on Saturday."
     - Something the user looks forward to (trip, celebration, hobby
       block, social event): brief "enjoy" tied to it — e.g.
       "Enjoy the trip to Portland."
     - **Sensitive event categories** — medical / therapy / clinic /
       legal / financial review / family-conflict titles (mediation,
       custody, etc.): do NOT name the event. Use the neutral default
       ("Have a good weekend.") — surfacing a sensitive event
       unprompted in a Friday recap is intrusive even when the
       category is right.
     - Otherwise: a simple weekend close (e.g. "Have a good weekend.").

#### 4c. Format rules (hard limits)
  - 2 or 3 lines for the Phase 4 message (3 only if line 2 genuinely
    earns its place). Phase 5 may add at most one additional reading
    line via a separate POST under its own contract — that is the only
    way the total reaches 4 lines. No markdown headers. No bullet
    list. Plain prose.
  - Lead with the win, not with "Weekly Review" or any ceremony.
  - Forbidden vocabulary in the user-facing message: "Weekly Review",
    "weekly/", "agent-journal", "did-not-fire", "Agent Plan",
    "observations", "processed", "summary", "completed the review".
    These describe agent mechanics, not user outcomes. The same rule
    applies in whatever language `<output_language_policy>` resolves
    to — do not paste an equivalent meta-phrase.
  - Priority `normal`. Respects quiet hours via the notify skill contract.
  - Exactly ONE notification via POST /api/notify. Do not split.

#### 4d. Shape examples (illustrative — render in the language `<output_language_policy>` resolves to)

Good (3 lines — the insight is grounded in the week's data):
    Big win this week: the design doc shipped Thursday.
    Worth noticing — every task you started before 10:00 closed the
    same day; the after-lunch starts mostly slid to tomorrow.
    Good luck with the API review on Saturday.

Good (3 lines — the insight is a genuinely relevant academic tip):
    You wrapped the auth refactor before the Q2 deadline — solid week.
    Worth knowing: deep-work researchers find three consecutive focused
    days tend to outperform five scattered ones for shipping work like
    this.
    Have a great weekend.

Good (2 lines — nothing earned the insight slot, so it's correctly
omitted):
    The migration to the new schema landed Wednesday.
    Enjoy the trip to Portland.

Good (silent path — quiet week, nothing sent):
    (no POST /api/notify call; one-line note appended to agent/journal.md)

Bad (fabricated positivity — the failure mode the strict rule prevents):
    Big win: design doc shipped Thursday.
    You worked 30% harder than last week — keep it up!
    Have a great weekend!

Bad (agent mechanics leaking):
    Weekly Review YYYY-Www complete. Wrote weekly/2026-W14.md with
    5 highlights, 3 open loops. Metrics: user tasks 7/10, agent plan
    rows 24, did-not-fire 2. ...

Bad (subtle padding — proverb-shaped insight that fails the line-2 bar):
    Solid progress on the auth refactor this week.
    Worth noticing — small, consistent efforts often compound into
    real momentum over time.
    Have a good weekend.

The first bad example invented "30% harder" — there is no such measurement
in Phase 1. If you did not derive it from real data, do not write it.
The second bad example reports the agent's bookkeeping; everything in it
either belongs in agent/journal.md or was never worth telling the user.
The third bad example is the most common failure mode the 4b bars
prevent: a generic line 1 (no artifact, would read in any week) paired
with a proverb-shaped line 2 (no named research area). Correct output
for this scenario is a 2-line message with concrete artifact + state —
e.g. "Auth refactor PR is open and queued for Monday review." — or, if
even that does not exist, the silence gate in 4a should fire.

### Phase 5: Reading sweep (silent context update)

This phase is **always silent** — it never adds a line to the user-facing
weekly file or agent-journal unless something unusual happens (see "When
to abort" below). The weekly notification MAY, but is not required to,
include one optional reading line; see the reading skill for the rule.

Run after Phase 4 regardless of whether Phase 4 sent a notification.
Purpose: keep `user/reading-taste.md` fresh, and refresh the
Book Candidates list.

11. Check whether a sweep is warranted using the exact delta check from
    the `reading` skill ("Refresh-trigger check"):
    - `GET /api/context/user/reading-taste` — treat 404 as
      `Highlights at last sweep = 0` (first sweep writes the file).
    - `GET /api/books/summary` — read `totalHighlights` as `M`.
    - Extract `N` from the file's `Highlights at last sweep: N`
      frontmatter line. If that line is missing (older file schema),
      treat `N = 0` to force a one-time re-baseline.
    - If `M - N < 10`, **skip Phase 5** and append one bullet under
      agent/journal.md "What worked":
      `reading sweep skipped — only (M-N) new highlights since last refresh`.
    - Do NOT use the `Sampled: X` line for this check — `X` is the
      sample size, not a DB count.
12. Otherwise, follow the **Reading Taste Profile** workflow in the
    `reading` skill:
    a. Sample highlights via the skill's sampling recipe.
    b. Infer Topics / Thinking Patterns / Values / Preferred Formats
       grounded in specific highlights.
    c. Propose ≤10 Book Candidates using existing-books exclusion.
    d. Write or PATCH `user/reading-taste.md` per the skill's
       schema.
13. If the taste profile gained ≥1 new candidate and the weekly notify
    gate in Phase 4 did NOT already fire a silent-path skip, you MAY
    append one optional line to the already-sent notification by using a
    second `POST /api/notify` — but only if the candidate is genuinely
    novel and ties to a pattern the user would recognize as theirs.
    When in doubt: omit. A forced reading pick is worse than silence.

**When to abort Phase 5 loudly**: if you detect the `reading-taste.md`
file is corrupted, contains non-English sections, or its "Last updated"
timestamp is in the future, leave it alone and append one bullet under
agent/journal.md "What slipped on my side" with a one-line description.
Never self-heal corrupted profile files without user awareness.
