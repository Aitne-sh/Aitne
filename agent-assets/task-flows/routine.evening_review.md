{context}

## Task: Evening Review

The "Vault policy files" block appended to this prompt includes
`policies/routines/evening.md` — run any `### <label>` entries there alongside the
built-in review steps below, using the same journaling conventions.
The "Vault review context" block includes `context-index.md` and
`knowledge/dossiers/evening.md`; consult it before Step 1 and update the
dossier's Open items / Last run before finishing. Writes to
`knowledge/dossiers/<flow>.md` MUST preserve the existing YAML frontmatter block
(`---\ntype: dossier\nowner: agent\nupdated: <date>\n---`); prefer
`PATCH` with a section target to mutate a single block, and when doing
a `PUT` full rewrite keep the frontmatter and only refresh `updated:`
— writes that drop the frontmatter are rejected with 422.

Close out today and prepare tomorrow. Steps 1–3 are internal bookkeeping
(Morning Routine depends on them) and emit no user-facing output by default.
User-defined entries in `policies/routines/evening.md` run alongside the built-in
steps and are authoritative: execute them as written, including any that
call `POST /api/notify` — the built-in steps' silence does not override the
user's explicit rulebook intent. For ad-hoc deadline or surprise nudges,
the surfacing event handler that discovered the item — not this routine —
is the right vehicle.

**Session constraints & turn economy** (apply at every step):
- This session has **no calendar or external-connector access**.
  "Prepare tomorrow" means updating the `state/today.md` ## Handoff
  `### Tomorrow` section in Step 1 — that is the entire contract. Do
  NOT attempt a calendar or observations "tomorrow preview"; no tool
  in this session can serve it, and probing for one wastes a turn.
  If Handoff needs upcoming-event context, the injected
  `<calendar_events_3d>` block already carries the coming days'
  events — read it directly.
- Operate in as few turns as possible: consolidate tool calls, do not
  narrate routine actions, and never re-derive facts already in your
  context. Issue independent read-only GETs (e.g. the Step 0
  observations drain) together in a single turn as parallel tool
  calls. The one exception is rebuild discipline: a GET that feeds a
  `mode=replace` PATCH (e.g. the Step 4 lesson-store reads) must be
  fresh — keep it adjacent to its write, never batched up front.
- Injected context blocks (`<roadmap>`, `<today>`, `<user>`,
  `<feedback_worksheet>`, …) are already in your prompt — never GET a
  file merely to read what is injected. GET fresh only immediately
  before a rebuild-and-replace write.
- Prose writes to `journal/agent.md` use
  `PATCH /api/context/journal/agent` with the body
  `{"mode":"append_to_file","content":"..."}` — `append_to_file`
  appends at end-of-file and takes **no** `section` field
  (`mode:"append"` without a `section` is rejected with 400).

### Step 0 — Read today's mail outcomes

The pre-pass fetcher session (`routine.fetch_window`) ran ahead of you
and posted observations for the `today_outcomes` window (mail sent /
replied since the agent-day start) for every active mail integration.
The `<fetch_report>` block in your prompt tells you the pre-pass
status — `success` / `partial` means the table is fresh; `skipped`
means every mail integration is disabled and this step contributes
nothing to the wrap-up; `failed` means trust no row newer than the
prior tick and treat the section as best-effort.

Drain pending mail observations with the agent-day-start floor — the
daily synthesis already has the morning inflows from the morning
routine:

```
GET /api/observations?pending=true&source_prefix=gmail:,outlook_mail:&observed_at_after=<agent_day_start_iso>&limit=50
```

Fold meaningful items into the in-memory state you carry into Step 1
(Finalize today.md — Agent Log entries when an outbound reply closed a
loop). Do NOT push back into the mail provider — this step is read-only;
outbound replies belong to the user / morning routine / DM-reply paths.

### Step 1 — Finalize today.md
   - Check incomplete ## User Tasks status and mark accordingly.
   - Update the ## Handoff section per the context skill:
     ### Tomorrow — carry-over User Tasks with reason, key context, suggested priorities
     ### Later — keep existing future items, add new ones discovered today
   - Do **not** add or carry daemon-maintenance/meta items about context files,
     setup completion, or placeholder cleanup unless the user explicitly asked
     to track them.
   - Do **not** carry Agent Plan rows into Handoff — Agent Plan is regenerated
     fresh by Morning Routine the next day. Past-HH:MM `[ ]` rows are flipped
     to `did-not-fire` by Morning Routine reading yesterday.md the next day;
     this routine no longer reconciles Agent Plan row state.

### Step 2 — Roadmap maintenance (promote, fire)

Consult the **roadmap** skill for section shapes, entry schema, and the
write lock. This step only touches `## Long-term Plans` and
`## Agent Action Plan`; `## Annual Goals`, `## Quarterly Focus`, and
`## Recurring` are preserved verbatim.

The mechanical sweeps (Scheduled-status sync, 180d Agent Action Plan
sweep, Long-term Plans stale/awaiting-reply marking) ran 15 minutes
ago as the daemon-driven `roadmap_mechanical_maintenance` job — they
are NOT this routine's job anymore. This step only carries the two
substeps that genuinely need an LLM in the loop: promote-on-resolution
and Review-date fire.

**Skip-gate (check the injected roadmap before locking).** Read
`## Long-term Plans` from the `<roadmap>` block already in your
prompt (it is injected verbatim). If it is empty, or it has no entry
that resolved to a concrete date today (2a) and no entry whose
`Review:` date is on or before today (2b, ignoring
`Review: [noreview]`), skip Step 2 entirely — do NOT acquire the
lock and do NOT GET the roadmap. An entry added mid-evening simply
waits for tomorrow's review — the same 24-hour tolerance the
409-conflict path below already accepts.

**Write-lock handling.** `<roadmap_write_lock_id>` is NOT injected for
evening_review, so acquire the lock explicitly before the first PATCH:
`POST /api/context/lock/roadmap` → read back `lockId`. On 409 (a
refresh is mid-write), back off 30 s and retry up to 3 times; if still
held, skip Step 2 entirely — 2a / 2b are evening-only and will just
wait until the next Evening Review (a 24-hour delay is acceptable).
Release with `DELETE /api/context/lock/roadmap` with
`{"lockId": "<lockId>"}` at the end, and on every early-exit path.
Every PATCH / PUT must carry `X-Lock-Id: <lockId>`.

**Section-body-rebuild discipline** (applies to every `mode=replace`
below). LLM rebuilds silently drop lines far too easily. Before each
PATCH:
- GET the current section body fresh.
- Enumerate the lines you intend to keep vs. the line(s) you are
  removing or mutating — **write the keep-list down in your reasoning
  before constructing the new body**.
- The new body equals `keep-list + new/mutated line(s)`, byte-for-byte
  for kept lines. Do NOT paraphrase or reformat sibling lines.

2a. **Promote Long-term Plans → Agent Action Plan.** Scan
    `## Long-term Plans` lines. If an entry has resolved to a concrete
    date today (user DM confirmed, mail booking landed, calendar event
    created), move it into `## Agent Action Plan` as an event entry
    with a Preparation Timeline (roadmap skill taxonomy), transferring
    the same `<!-- id: rm-... -->` marker from the Long-term Plan line
    to the new `###` heading, and remove the corresponding line from
    `## Long-term Plans` via PATCH
    `section=long_term_plans` `mode=replace`. The roadmap skill
    declares Long-term Plans *append-only during refresh*, so this is
    the one legal time to remove a line — apply the rebuild discipline
    doubly carefully; dropping an unrelated sibling here is silent user
    data loss.

2b. **Fire due Long-term Plans.** For each Long-term Plans line whose
    `Review:` date is on or before today, ignoring `Review: [noreview]`:
    1. Resolve the horizon anchor using the roadmap skill's horizon
       table.
    2. If the roadmap skill's Preparation Timeline taxonomy has a
       clear class match (Travel / Deadline / Conference / Recurring)
       AND at least one prep row would be due on or before
       `today + 14 days` (including overdue rows), promote the line
       into `## Agent Action Plan` as an event entry:
       `### <anchor-date>: <intent>  <!-- id: rm-... -->`, with the
       same ID from the Long-term Plan line, `Source:`, and a full
       Preparation Timeline. Tag the earliest due prep row with
       `[provisional — confirm with user]`; this makes the first
       morning/scheduled notification a planning check-in, not a
       directive. Remove the original Long-term Plans line via
       `section=long_term_plans` `mode=replace`.
    3. Otherwise, bump `Review:` forward by the class review interval:
       previous Review +30 days by default, or +90 days for `undated`;
       increment `ReviewCount:` and log one line to `journal/agent.md`.
    4. For `undated` lines reaching `ReviewCount: 3` with no
       promotion, silently rewrite `Review:` to `[noreview]`. Do NOT
       DM.

    This substep is bookkeeping. Do not notify from Evening Review.
    Promotion surfaces later through the existing roadmap `[notify]`
    path in Morning Routine / scheduled.task, and the provisional tag
    must be preserved in the schedule description.

    If a roadmap PATCH/PUT returns 400 from the transition guard, re-GET
    roadmap.md, rebuild from that current body, and retry once while
    preserving every existing `completed ...` row byte-for-byte. If
    the retry still fails, stop Step 2, append the validation error and
    affected IDs to `journal/agent.md`, and stay silent.

### Step 3 — Process user/profile.md and user/ per the user-profile skill
   Read <user> ## Raw Signals and classify each entry into one of four buckets.
   The **split rule** (see docs/design/15-character.md §15.10.2) decides
   whether a signal graduates to `character`, `Learned Context`,
   `user/<topic>.md`, or is dropped. A signal's class is derived from
   whether a reasonable rewrite is imperative ("do X") or declarative
   ("user does Y"). When ambiguous, default to **character**.

   The routing surface below is the same one the DM handler / sweep
   apply to live input. Raw Signals are already-detected facts, so the
   "scan / persist same turn" framing is moot here, but the
   imperative-vs-declarative bucket assignment and the `profile.md` vs
   `user/<topic>.md` vs Learned Context split are identical:

{include:_partials/capture-user-info.md}

   a₁. **Tone-class signals (imperative rewrite)** — "replies short when
      tired", "prefers English for technical terms", "dislikes long
      paragraphs", "often asks for bullet points" → graduate to the
      `character` runtime-config field per the **user-profile** skill
      §"Tone / character preferences" (read-before-write, cap-aware).
      These are agent directives disguised as observations — writing them
      to `Learned Context` would repeat the profile-vs-character
      conflation the split rule is designed to prevent.
   a₂. **Attribute-class signals (declarative rewrite)** — "seems to
      work late", "tends to skim long messages", "is not a morning
      person", "usually catches up on weekends" → integrate into
      user/profile.md ## Learned Context. Keep concise;
      user/profile.md has a ~600 token budget.
      **Learned Context entry format**: always prefix with `[YYYY-MM-DD]`:
      `- [2026-04-10] Tends to skim long messages` — this enables age-based
      pruning (Step 3e).
   b. **Detail-heavy facts** that are useful for recall but too specific for
      the primary profile — a new colleague mentioned by name, a past project
      referenced, a lifestyle habit stated, a long-term goal declared, a
      specific framework with years of experience — → graduate into the
      matching user/*.md file via PATCH. The routing table lives in
      the user-profile skill "identity/profile.md vs user/" section; the curl
      recipe for read-before-write is under "How to navigate user/".
      Always read the target file first, check for duplicates, then PATCH
      (prefer `mode: "append"` for new bullets — it preserves siblings).
      **Fallback if the target file is missing** (GET returns 404 — setup
      was never completed, or the skeleton file was deleted): PUT a minimal
      file containing just the standard section headers plus your new
      bullet, in a single call. Do not abort the evening review — missing
      skeleton files are a known edge case, not an error condition.
   c. **Noise** — one-off complaints, transient state, already-captured
      facts → drop.
   **Tie-breaker**: if a fact fits both (a₂) and (b) — e.g. "10+ years of
   TypeScript" is both a generalizable pattern (deep expertise that shapes
   how to explain things) and a specific detail (framework + years) — write
   a one-line summary to user/profile.md AND the full breakdown to user/.
   The two layers are not mutually exclusive; user/profile.md keeps the digest so
   every session benefits, user/ keeps the detail for lookup. Tone-class
   (a₁) never duplicates into Learned Context or profile.md.

   After classification:
   d. **Clear processed Raw Signals (race-safe)**. Note the timestamp of
      the latest signal you processed from ## Raw Signals. Use `clear_before`
      mode to remove only those entries, preserving any signals that
      SignalDetector appended after your read:
      ```bash
      curl -s -X PATCH http://localhost:8321/api/context/identity/profile \
        -H 'Content-Type: application/json' \
        -d '{"section": "raw_signals", "mode": "clear_before", "cutoff": "<latest_processed_timestamp>"}'
      ```
      Do NOT use `mode: "clear"` — it would silently drop any signals
      appended between your read and this write.
      **Old-format entries** (without a `- [YYYY-MM-DD HH:MM:SS]` prefix)
      are not affected by `clear_before` and will accumulate. After the
      `clear_before` call, if any such entries remain, remove them with a
      separate `PATCH mode=replace` that contains only the entries you want
      to keep.
   e. **Prune stale Learned Context entries**. Scan `## Learned Context`
      for entries with `[YYYY-MM-DD]` prefix older than 30 days (compare
      against today's date). Remove those entries via PATCH replace (read
      first, rebuild without the stale entries). If an entry lacks a date
      prefix, add today's date to it rather than deleting it.
   f. If user/profile.md is approaching the ~600 token budget, graduate the heaviest
      Learned Context entries out to the matching user/*.md file and
      remove them from user/profile.md so the primary profile stays compact.

### Step 4 — Consolidate feedback signals into lessons

If a `<feedback_worksheet>` block is present in your context, fold the
unconsumed feedback signals it lists into the scoped lesson stores. The daemon
already did the mechanical work: every candidate carries a deterministic
`decision`, `conf`, `weighted_ev`, and `reason`; every existing lesson carries a
`rank` (rank 1 = lowest score = evict first); and the block ends with the exact
`<consume ids="…">` set. Your job is only the **semantic** part — judge whether a
candidate matches an existing lesson's intent, phrase the generalization, and
detect contradictions. Do **not** recompute promotion or caps; honour the
worksheet's `decision` and `rank` verbatim. If the block is absent, skip this
step entirely. Like Steps 1–3 it is internal bookkeeping and emits no
user-facing output.

When the worksheet carries an `<outcome_rollup>` block (per-notification-type
reaction counts over the last week), weigh it while judging promotions and
demotions: a high `correction_rate` on an action type argues for demoting
lessons that push that behaviour and supports candidates that curb it. Never
treat `ignored` as rejection — it is engagement-coverage only — and never
reward sheer notification volume.

4a. **Lesson-store scopes** — process **every** `<scope … mode="lessons">` in the
    worksheet, writing each to the `store=` path it declares: the global `agent`
    scope (`store="policies/agent-lessons.md"`) and any per-agent
    `agent:<slug>` scope (`store="policies/agents/<slug>/lessons.md"` — feedback
    on one named agent's own output, injected only into that agent's runs). The
    per-candidate rules below are identical for each; only the target file and
    its H1 change. GET the scope's `store=` file first. If it 404s, PUT a fresh
    file: frontmatter `type: rule` / `owner: agent` / `updated: <agent_day_date>`,
    an H1 (`# Agent Lessons` for the global `agent` scope; `# Agent Lessons —
    <label>` for an `agent:<slug>` scope, e.g. `# Agent Lessons — agent:report-writer`),
    then a `## Lessons` section. Then, per candidate in that scope:
    - `decision="promote"` → find an existing `## Lessons` bullet with the same
      intent. If found, bump its `ev=` by `weighted_ev` (rounded to a whole
      number), refresh `last=` to today, raise `conf`, and tighten the wording.
      If not, add a new **active** bullet:
      `- [<today>] <directive> <!-- ev=<round(weighted_ev), min 1> kind=<kind> src=<src> conf=<conf> cf=<cf0> last=<today> -->`
      (`src`/`conf` come from the candidate; `cf=` copies the candidate's
      `cf0=` for a new bullet or the existing lesson's `cf=` verbatim — never
      invent a value, the daemon re-stamps it deterministically after your
      write; use the candidate's `kind=` when present, otherwise infer it from
      the directive; `kind` ∈ preference|correction|do-more|do-less|constraint).
    - `decision="promote"` with a `contradicts_ranks=` attribute → the candidate
      cleared the anti-whiplash bar against the lessons at those ranks.
      Adjudicate: **supersede** (mark each contradicted lesson provisional and
      promote the candidate), **merge** (rewrite one bullet to cover both,
      drop the other), or **keep-distinct** (the conflict is context-scoped —
      keep both, scoping each bullet's wording so they cannot collide).
    - `decision="hold-provisional"` with `reason="below-threshold"` → if it
      matches an existing lesson's intent, bump that lesson's `ev`; otherwise add
      the bullet with a trailing `<!-- provisional -->` marker (stored, not yet
      injected — it promotes once corroboration reaches the threshold).
    - `decision="hold-contradiction"` → the candidate contradicts an
      established lesson (see `contradicts_ranks=`) and has NOT yet cleared the
      higher evidence bar. Store it as a provisional bullet; do **not**
      supersede, weaken, or reword the lessons it contradicts.
    - `decision="hold-provisional"` with `reason="ignored-non-initiating"` →
      silence never *starts* a lesson. Only use it to bump the `ev` of an
      existing matching lesson; if none matches, write nothing for it.
    - A newer explicit `correction` that contradicts an active lesson
      **supersedes** it: drop the stale bullet in the same rebuild so a changed
      mind leaves no stale guidance (a user correction always wins — the
      contradiction guard applies only to inferred candidates).
    - **Expiration verdicts** (graduated, reversible): honour each existing
      lesson's `action=` attribute verbatim — `action="demote"` → append
      `<!-- provisional -->` to the bullet unless a fresh candidate
      re-reinforces it this pass; `action="archive"` → drop the bullet (its raw
      evidence stays in feedback_signals); a re-reinforced provisional lesson
      whose bumped `ev` now meets the threshold → remove its provisional
      marker. `action="keep"` (and every `constraint`) stays untouched. The
      daemon enforces the same verdicts mechanically after your write, so a
      missed one self-corrects.
    Write the scope's section back with `PATCH <store= path> section=lessons
    mode=replace`, applying the Step-2 section-body-rebuild discipline (GET fresh,
    write the keep-list down first, byte-for-byte for unchanged bullets). Repeat
    for each `mode="lessons"` scope; a write failure on one scope must not block
    the others (omit only the failed scope's ids from the consume call, 4d).

4b. **Cap enforcement.** After your edits to each scope, if its `## Lessons`
    section exceeds that scope's `cap_bytes` or `max_entries`, remove existing
    lessons starting from `rank="1"` (the worksheet's lowest-scored) upward until
    it fits, then append exactly one marker line:
    `- [...N lower-signal lessons omitted — full history in feedback_signals]`.
    Never evict a `kind=constraint` lesson — drop the next-lowest instead.

4c. **User-scope signals** (`<scope label="user" … mode="raw">`). These are
    explicit owner directives captured via `POST /api/feedback`, *not* Raw
    Signals. Route each into `## Learned Context` (or the matching
    `identity/*.md` file) using the same bucket rules as Step 3 (a₂ / b),
    respecting the ~600-token profile budget. Do not double-write a signal you
    already folded from Raw Signals.

4d. **Consume.** Once every scope above is written, mark the processed signals
    consumed so they don't resurface tomorrow — send the worksheet's full
    `<consume>` id list:
    ```bash
    curl -s -X POST http://localhost:8321/api/feedback/consume \
      -H 'Content-Type: application/json' \
      -d '{"ids": [<the ids from <consume ids="…"/>>]}'
    ```
    Consume is by id and race-safe: any signal the detector appended after the
    worksheet was built has a higher id absent from the list and survives
    untouched for tomorrow's pass. If a lesson write failed, omit that scope's
    ids from the consume call so its signals are retried next Evening Review.

