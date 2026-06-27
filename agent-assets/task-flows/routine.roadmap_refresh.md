{context}

## Task: Roadmap Refresh

The "Vault policy files" block appended to this prompt includes
`policies/routines/monthly.md` — run any `### <label>` entries there that affect
long-horizon planning alongside the built-in roadmap-refresh steps below,
using the same journaling conventions.
The "Vault review context" block includes `context-index.md` and
`knowledge/dossiers/roadmap.md`; consult it during signal gathering and update the
dossier's Open items / Last run before finishing. Writes to
`knowledge/dossiers/<flow>.md` MUST preserve the existing YAML frontmatter block
(`---\ntype: dossier\nowner: agent\nupdated: <date>\n---`); prefer
`PATCH` with a section target to mutate a single block, and when doing
a `PUT` full rewrite keep the frontmatter and only refresh `updated:`
— writes that drop the frontmatter are rejected with 422.

Update `plans/roadmap.md` with a forward-looking agent action plan based on the
next 90 days. The `roadmap` skill owns the section schema, the
dated-vs-undated decision tree, the Preparation Timeline taxonomy
(Travel / Deadlines / Conferences / Recurring), destination extraction,
the `travel_bookings` cross-check, and the cross-request write lock —
consult it for the rules your output must satisfy. This task flow only
coordinates the high-level gather → analyze → write loop.

### Phase 1: Gather Data
1. **Calendar (next 90 days).** The `<calendar_events_90d>` block in your
   prompt is the canonical surface for every active calendar provider
   (`google_calendar`, `outlook_calendar`) across all four integration
   modes. The daemon emits one `<provider key="..." mode="...">` sub-block
   per active provider; consume each per its mode:

   - **`mode="direct"`** — the sub-block contains the pre-fetched events
     for the next 90 days, already grouped by date. Read inline; no
     additional fetch is needed. (If the sub-block instead carries the
     "direct mode, daemon service not initialized" hint, fall back to
     `GET /api/calendar/events?date=today&days=90` for Google or
     `GET /api/calendar/outlook?date=today&days=90` for Outlook as the
     hint instructs.)
   - **`mode="delegated"`** — follow the directive verbatim. It tells you
     whether this is same-backend (use your session's Calendar MCP tool)
     or cross-backend (POST `/api/integrations/<key>/exec`), substituting
     the `timeMin` / `timeMax` carried on the `<calendar_events_90d>`
     wrapper.
   - **`mode="native"`** — follow the directive verbatim. Native bindings
     never go through the daemon; call your session backend's Calendar
     MCP tool directly with the `timeMin` / `timeMax` from the wrapper.
     If `<integration_modes>` shows the provider's `_native_to` is a
     different backend than yours, treat the provider as unavailable for
     this turn (per the directive).
   - **No sub-block for a provider** — that provider is disabled; skip
     it without retry.

   If `<calendar_events_90d>` is replaced by
   `<calendar_status>Calendar service not available...</calendar_status>`
   (no provider is active in any mode), skip calendar-derived steps in
   Phase 2 (event entries, prep timelines, travel cross-check) and
   proceed with the rest of Phase 1 — the refresh still bumps `Last
   synced` and updates `## Annual Goals` / `## Quarterly Focus`
   placeholders so the file does not drift.

   If a directive fetch errors out (non-2xx / connector unavailable),
   log one line to `## Agent Log`, drop that provider's events for this
   run, and proceed — do not retry inline.

   **Cover the full 90-day window with equal priority.** The live
   calendar poller only watches the next ~15 days, so any event the
   user scheduled farther out reaches `plans/roadmap.md` *exclusively*
   through this routine — under-coverage of the day+15 → day+90
   horizon is the primary failure mode this refresh is designed to
   prevent. Read every day of the block (including empty days, which
   render as `- (no events)`), not just this week.

2. Fetch pending and running scheduled tasks:
   ```
   curl -s 'http://localhost:8321/api/schedule?status=pending,running&roadmapEligible=true'
   ```
   The response is `{ items: [{ id, scheduledFor, taskType, description, status, model, backendId, tier, taskContext, createdAt }, ...] }`. `model` is a registered id verbatim (`claude-opus-4-8`, `gpt-5.4`, …) paired with `backendId` when the row pins a specific model; otherwise the pin lives in `tier`.
   The daemon has already applied the roadmap visibility filter:
   `transient` / `low` are excluded, `normal` / unspecified rows are
   included only beyond the 7-day horizon, and `strategic` rows are
   included regardless of horizon. Treat the returned rows as
   `Scheduled:` candidates — they represent commitments the user should
   see at morning review (e.g. "you'll be reminded about ESTA in 3 weeks").

3. Fetch pending `roadmap_candidate` observations — weak signals queued
   by `routine.activity_scan` (far-future calendar changes, user-edited
   vault notes mentioning trips / deadlines, etc.) that the activity-scan flow
   deliberately did NOT write to roadmap directly:
   ```
   curl -s 'http://localhost:8321/api/observations?source=roadmap_candidate&pending=true&limit=50'
   ```
   Keep the `id` for each observation — Phase 2 step 7 consumes them
   after incorporating the signal (or after deciding to drop it as
   noise). `source` is a prefix match, so `roadmap_candidate:travel`,
   `roadmap_candidate:calendar`, etc. are all picked up by the plain
   `roadmap_candidate` filter.

4. Fetch upcoming travel bookings — authoritative flight / hotel rows
   already detected by the mail pipeline:
   ```
   curl -s 'http://localhost:8321/api/travel-bookings/upcoming?limit=50'
   ```
   Use these for the `roadmap` skill's `travel_bookings` cross-check
   when emitting or refining event entries — mark corresponding `[check]`
   prep lines as `completed` Preparation Timeline rows and record the
   confirmation number in **Agent Notes**. A booking whose `start_date`
   is ≥ 48h out without a matching calendar event is itself a trigger
   for a new event entry.

5. Scan `<recent_dm_conversation_log days="7">` for long-horizon user
   intent that has not yet landed anywhere (e.g. *"going to LA next
   month"*). Apply the `roadmap` skill's Long-horizon DM-intent detection
   block to each candidate summary — only route items that match the
   **positive signals** (explicit forward-looking verb + horizon,
   specific future date ≥ 48h out, concrete object) into the roadmap in
   Phase 2. Ambiguous / speculative items stay out of `## Long-term
   Plans` and `## Agent Action Plan` — they belong in `agent-journal.md`
   as candidate lines for the next morning routine to confirm.

### Phase 2: Analyze & Build Action Plan
3. Read the current <roadmap> content (if any).
   - **Preserve verbatim** the following sections — these are either
     user-authored or carry state the refresh must not overwrite:
     - `## Annual Goals`
     - `## Quarterly Focus`
     - `## Long-term Plans`
     - `## Recurring`
   - If `## Annual Goals` or `## Quarterly Focus` contain
     "(Not yet configured)", replace with:
     "[placeholder — update with your actual goals]"
   - **Legacy compat:** if any of the preserved sections are absent
     (e.g. a pre-MVP roadmap without `## Long-term Plans`), emit the
     section **empty** in Phase 3 — do not treat absence as missing
     data and do not fabricate content.

4. Build `## Agent Action Plan` by **merge-by-id**, not wholesale
   anonymous regeneration.
   1. For each dated calendar event or booking in the next 90 days
      that the `roadmap` skill's decision tree routes to Agent Action
      Plan (specific date >48h out), compute the intended roadmap ID.
      Apply the noise filter (see `### Important` below) conservatively
      — events more than 30 days out **default to include**: at that
      horizon they are almost always deliberate user signals, and
      absence from the existing roadmap means creation, not noise.
      Prefer:
      explicit `roadmap_entry_id` / `payload.roadmap_entry_id` from a
      queued observation; else an existing AAP entry with the same ID;
      else an existing Long-term Plan candidate matched conservatively
      by destination/date (promotion case); else legacy title+date
      matching only during migration; else mint a fresh ID via
      `POST /api/context/plans/roadmap/id` using the Source/creation date.
   2. If an existing AAP entry has this ID, merge: keep every
      `completed ...` Preparation Timeline row byte-for-byte; re-emit
      non-completed taxonomy rows only for gaps by lead-time offset.
      Never drop a completed row.
   3. If no existing entry has this ID, emit a fresh entry with the ID
      marker on the `###` heading.
   4. Follow the `roadmap` skill for classification (Travel
      international/domestic, Deadlines, Conferences, Recurring
      milestones), per-class prep-line recipes, destination extraction,
      and `travel_bookings` cross-check before emitting flight /
      accommodation `[check]` lines.

   Add **Agent Notes** under each event for supplementary info
   (timezone differences, application URLs, tips, etc.).

5. For each pending/running scheduled task fetched in Phase 1 step 2
   that passed the importance / horizon filter, emit a `Scheduled:`
   entry under `## Agent Action Plan` using the shape defined by the
   `roadmap` skill. Preserve the existing ID for the same task id when
   present; otherwise mint one with creation date = task `createdAt`
   date (fallback to wake-up date if missing):

   ```
   ### Scheduled: <description>  (task #<id>)  <!-- id: rm-YYYYMMDD-abcdef -->
   Source: scheduled.task — wake-up YYYY-MM-DD HH:MM
   Status: pending   (or running / completed / failed)
   ```

   Keep `Scheduled:` entries and event entries interleaved in
   `## Agent Action Plan`, ordered by their primary date.

6. Incorporate each pending `roadmap_candidate` observation fetched in
   Phase 1 step 3. For each row, inspect `payload` and route per the
   `roadmap` skill decision tree — into `## Agent Action Plan` if dated
   and >48h out, `## Long-term Plans` if undated, or drop as noise. If
   the candidate is already represented (e.g. a `travel_booking_detected`
   refresh fired the same morning and an event entry already exists),
   skip without duplicating. If `payload.roadmap_entry_id` is present,
   consult that ID before emitting a new entry or matching by text.

7. Consume the observations whose candidate was incorporated or
   deliberately dropped. Copy the `correlationId` value verbatim from
   the `<event_correlation_id>…</event_correlation_id>` tag in your
   turn context — do not paste the placeholder. Bulk-only; the per-id
   form does not exist. Field contract is in the `observations`
   skill ("POST /api/observations/consume").
   ```bash
   curl -s -X POST http://localhost:8321/api/observations/consume \
     -H 'Content-Type: application/json' \
     -d '{"ids":[<id>, ...],"correlationId":"<copied-from-event_correlation_id-tag>"}'
   ```
   Observations left pending here will re-appear on the next refresh.

8. Remove entries by ID plus date, never by broad string matching.
   Remove events only when their ID's primary date is outside the
   retention window defined in the roadmap skill. Keep completed
   Preparation Timeline rows while the entry itself remains in window.
   Remove `Scheduled:` entries whose task `id` is not in the fresh
   `/api/schedule` response (cancelled or already completed more than
   a day ago).

### Phase 3: Write
9. **Long-horizon coverage check (pre-PUT audit).** Before issuing the
   PUT in step 10, walk every event in `<calendar_events_90d>` whose
   start is between today+7d and today+90d and whose summary is
   non-empty (skip `- (no events)` filler lines). Each such event must
   end in exactly one of:
   - represented in `## Agent Action Plan` (event entry or promotion
     from `## Long-term Plans`), or
   - represented in `## Long-term Plans` with a concrete horizon-tag
     (when the calendar date is itself tentative and DM intent is the
     stronger signal), or
   - explicitly logged to `## Agent Log` with a one-line reason for
     exclusion (e.g. `excluded: recurring weekly 1:1 — handled by
     today.md`).

   Silent drops are the failure mode this gate exists to surface. If
   any event lacks one of the three resolutions, add the missing entry
   or log line before proceeding to step 10. An audit with zero log
   lines is fine when every event mapped cleanly into AAP / Long-term
   Plans; a missed long-horizon trip / deadline / conference is the
   specific regression this check is designed to prevent.

10. Always write the full roadmap via PUT, even when no substantive
   changes were warranted. Update `> Last synced` to today's date on
   every run so the mtime advances deterministically. If
   `<roadmap_write_lock_id>` is in context, include it as the
   `X-Lock-Id` header so other concurrent writers see 409 and back off:
   ```
   curl -s -X PUT http://localhost:8321/api/context/plans/roadmap \
     -H 'Content-Type: application/json' \
     -H 'X-Lock-Id: <roadmap_write_lock_id>' \
     -d '{"content": "..."}'
   ```

   An empty `## Agent Action Plan` is permitted when no signals exist.

   Required structure (preserve existing body inside each section;
   `## Agent Action Plan` is merge-by-id):
   ```
   # Roadmap
   > Last synced: YYYY-MM-DD

   ## Annual Goals
   (preserved verbatim from existing)

   ## Quarterly Focus
   (preserved verbatim from existing)

   ## Long-term Plans
   (preserved verbatim from existing; agent-writable via the roadmap
    skill for undated long-horizon intents — do not clear this section
    during refresh)

   ## Agent Action Plan

   ### YYYY-MM-DD ~ MM-DD: Event Title  <!-- id: rm-YYYYMMDD-abcdef -->
   Source: Google Calendar / Notion / etc.

   **Preparation Timeline:**
   - YYYY-MM-DD [tag]: Action description
   - completed YYYY-MM-DD: YYYY-MM-DD [tag]: Completed action
   - ...

   **Agent Notes:**
   - Supplementary information

   ### Scheduled: <description>  (task #<id>)  <!-- id: rm-YYYYMMDD-abcdef -->
   Source: scheduled.task — wake-up YYYY-MM-DD HH:MM
   Status: pending

   ## Recurring
   (preserved verbatim from existing)
   ```

11. If the PUT returns 400 from the roadmap transition guard (for
    example, a completed row was dropped), recover once:
    1. Re-GET `/api/context/plans/roadmap`.
    2. Re-run the merge using the current body as authoritative,
       preserving every `completed ...` row byte-for-byte.
    3. retry the full PUT once with the same lock id.
    4. If the second write also returns 400, do not write the regenerated
       Agent Action Plan. Instead, PUT a minimal update that only bumps
       `> Last synced` on the current body, append a diagnostic section
       to `journal/agent.md` with the validation error and affected IDs,
       and end silently.

### Important
- Do NOT notify the user about this refresh — it is a background maintenance task.
- If no calendar events are found and no scheduled tasks are pending,
  write a minimal roadmap preserving existing goals / Long-term Plans /
  Recurring with an empty `## Agent Action Plan`. Always bump
  `> Last synced`.
- Keep roadmap.md concise — but apply the inclusion bar **asymmetrically by
  horizon**:
  - **within today+14d**: only include events that benefit from advance
    preparation; skip routine standups, 1:1s, daily meetings.
  - **beyond today+14d**: default to **include** every dated, non-recurring
    calendar event with a real summary. At that horizon entries are almost
    always deliberate user signals, and a missed long-horizon trip /
    deadline / conference is the failure mode this refresh exists to
    prevent.
  Recurring-series instances always belong in `## Recurring`, never in
  `## Agent Action Plan`, regardless of horizon.
