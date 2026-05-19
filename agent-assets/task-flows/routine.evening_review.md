{context}

## Task: Evening Review

The "Vault policy files" block appended to this prompt includes
`routines/evening.md` — run any `### <label>` entries there alongside the
built-in review steps below, using the same journaling conventions.
The "Vault review context" block includes `context-index.md` and
`dossiers/evening.md`; consult it before Step 1 and update the
dossier's Open items / Last run before finishing. Writes to
`dossiers/<flow>.md` MUST preserve the existing YAML frontmatter block
(`---\ntype: dossier\nowner: agent\nupdated: <date>\n---`); prefer
`PATCH` with a section target to mutate a single block, and when doing
a `PUT` full rewrite keep the frontmatter and only refresh `updated:`
— writes that drop the frontmatter are rejected with 422.

Close out today and prepare tomorrow. Steps 1–3 are internal bookkeeping
(Morning Routine depends on them) and emit no user-facing output by default.
User-defined entries in `routines/evening.md` run alongside the built-in
steps and are authoritative: execute them as written, including any that
call `POST /api/notify` — the built-in steps' silence does not override the
user's explicit rulebook intent. For ad-hoc deadline or surprise nudges,
the surfacing event handler that discovered the item — not this routine —
is the right vehicle.

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
       increment `ReviewCount:` and log one line to `agent/journal.md`.
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
    affected IDs to `agent/journal.md`, and stay silent.

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
      the user-profile skill "user/profile.md vs user/" section; the curl
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
      curl -s -X PATCH http://localhost:8321/api/context/user/profile \
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

