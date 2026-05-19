{context}

## Hourly Observation Review

This task-flow is the **daemon-internal** hourly cron — a built-in
observation review the dispatcher fires every hour. It is NOT the
user-facing hourly recurring schedule path. Operators who want to
register a custom hourly task should POST to
`/api/recurring-schedules` with `recurrenceRule.frequency:"hourly"`
(see the `schedule` skill's `references/recurring.md`); those rows
fire `scheduled.task` / `scheduled.dm` events instead.

The "Vault policy files" block appended to this prompt includes
`routines/hourly.md` — your canonical check list for this cadence.
The "Vault review context" block includes `context-index.md` and
`dossiers/hourly.md`; consult it before Step 1 and update the dossier's
Open items / Last run before finishing. Writes to `dossiers/<flow>.md`
MUST preserve the existing YAML frontmatter block (`---\ntype: dossier\nowner: agent\nupdated: <date>\n---`); prefer `PATCH` with a
section target to mutate a single block, and when doing a `PUT` full
rewrite keep the frontmatter and only refresh `updated:` — writes that
drop the frontmatter are rejected with 422.
Execute each `### <label>` entry in order, skipping any whose
precondition does not hold. The steps below are the built-in decision
framework for the observation-review step; additional checks the user
has added to the routine file run alongside them using the same
routing rules.

Output language: follow `<output_language_policy>` (Policy B for any
context-MD write-up; Policy C for the optional `POST /api/notify` DM).
Agent log appends to `agent/journal.md` stay English (Policy A).

Use the observations skill to fetch pending items. The pre-pass
fetcher session (`routine.fetch_window`) ran ahead of you and posted
small `unread_last_hour` / `imminent_2h` / `updated_1h` windows for
every active mail / calendar / notion integration; both `actor=user`
and `actor=agent` rows reach this session — the user-actor rows are
vault / git / file activity, the agent-actor rows are the windows
the pre-pass posted. The downstream steps draw on the merged view:

```
GET /api/observations?pending=true&limit=30
```

The legacy `actor=user&limit=20` query stays valid for sessions that
only want the user-actor surface (e.g. early triage). Follow the
context skill for today.md section formats and the day-type filter
mapping — this prompt owns the decision workflow only. Most runs should
do bookkeeping silently; only fire POST /api/notify on the urgency gate
in Step 8 below.

### Step 0 — Read pre-pass `<fetch_report>`

The `<fetch_report>` block in your prompt tells you the pre-pass
status:

- `status="success"` or `"partial"` → fresh mail / calendar / notion
  rows are visible in `/api/observations?pending=true`. Trust the
  table.
- `status="failed"` → the pre-pass crashed or its output was
  unparseable; treat the table as best-effort, fall back to
  user-actor rows for this tick.
- `status="skipped"` → no integration was active for this tick (or
  every applicable cell resolved to disabled); the table carries
  only user-actor signals.

Window sizes are intentionally small by design (typical: 0–2 mail
items, 0–1 calendar item, 0–3 notion pages) so this step costs
near-nothing on most ticks. The pre-pass partial bodies own the
per-(integration, mode) wire surface — do NOT call upstream
integration APIs from this session; treat the observations table as
authoritative from Step 1 onward.

### Execution budget
Target: 5–10 turns. If you reach 15 turns, wrap up current work and log.
Do NOT read roadmap.md, projects/*.md, or user/*.md unless an
observation warrants project-state context (e.g. references a project,
milestone, or deliverable — not merely a file edit in a watched repo).

### Stage gate decision (cost-reduction-structural §B)
The `<gate_decision>` block is always present — every Stage 3 enqueue
emits it. The block tells you *why* you were spawned — pull the
`reason` and `signals_snapshot` into your prioritisation. Examples:

- `reason: vip_mail_unread` → start with the mail observation, do not
  scan obsidian noise first.
- `reason: agent_plan_overdue` → re-check today.md `## Agent Plan` and
  decide whether to log a slip, reschedule, or notify.
- `reason: schedule_approaching` → fold the upcoming
  `agent_schedule` row into the run; don't pre-empt the schedule's
  own dispatcher.
- `reason: heartbeat_due` → low-signal heartbeat. Stay maximally
  silent unless something actually warrants action.
- `reason: cautious_escalate_prepass_failure` → the pre-pass fetcher
  failed for at least one non-direct integration this tick. The
  `<fetch_report status="failed">` block in your prompt tells you
  which integration is lossy; treat its observations as potentially
  stale and lean on whatever rows the previous tick left.

### Pre-summarized observations (cost-reduction-structural §A)
Every observation arrives with `summary_text` (≤120 chars) and
`novelty_score` (0–3) populated by the daemon's per-observation
summarizer. **Use those signals first** — fetch raw content (Obsidian
notes, git diffs, mail bodies) only when `novelty_score >= 2`, OR when
a different observation in the same batch references the same
path/ref. For `novelty_score === 1` use the summary alone; for `0`
silently consume. When `summary_status !== 'done'` (pending / skipped
/ failed) OR `summaryStale === true` (summary >6 h older than
observedAt) fall back to the legacy fetch-on-doubt rules in the
observations skill.

### Default stance — silence + idempotence
Most hourly runs are silent bookkeeping: consume observations, update
today.md, log, done. The baseline assumption for every step below is
that the user does NOT want another notification and does NOT want a
new Agent Plan row unless this run has something genuinely new to add.
The morning routine is authoritative for the day's plan; your job is
to fold in new signals, not to re-plan. Two hard rules:

- **No duplicate Agent Plan rows / schedules.** Before appending to
  `## Agent Plan` or calling `POST /api/schedule`, run the dedup
  pre-check in Step 4. If a matching row/schedule already exists,
  skip and log — never add a second one.
- **No duplicate notifications.** Before `POST /api/notify`, run the
  dedup pre-check in Step 8. If the same item was already notified
  earlier today, stay silent and log.

When in doubt, stay silent and log to `## Agent Log`.

### External services are read-only this hour

This routine reads external state for context — it does not push back. While running this hourly check, do **not**:

- Create / update / archive Notion pages or change Notion schema.
- Send / draft / move / tag mail.
- Create / update / delete calendar events.
- Open / merge / comment on GitHub PRs or issues.

External-source signals (`mail:*`, `notion:*`, `calendar:*`, `git:*`) reach you through `<observations>`. Consume them, route to `today.md` / `projects/*.md` / the `roadmap_candidate` queue per the Decision Framework below, but do **not** act back on the source system. Outbound writes against external services belong in the morning routine, evening review, or DM-reply paths — `routine.hourly_check` is a silent bookkeeping pass.

This rule applies regardless of integration mode (direct, same-backend delegated, cross-backend delegated). It is owned by the routine, so a session whose `notion` / `mail` / `external-services` skill body was dropped under same-backend delegation (because the connector covers the surface) still inherits the constraint.

### Decision Framework
1. Group related observations before acting. One concise update beats many small patches.
2. Classify each observation with a category tag: work/ folders, employer
   repos, Notion "Work" → `[work]`; coursework, study notes → `[study]`;
   journals, hobby repos, fitness, medical → `[personal]`; home logistics
   → `[home]`. Default `[personal]` when ambiguous.
3. Read the day-type filter on line 2 of <today>. Map categories to focus
   dimensions per the today skill's "Category → focus-dimension mapping".
   Drop observations whose focus is `off` and log:
   `- HH:MM [observations] skipped <n> item(s): <category> focus off`.
4. Route each surviving actionable observation to the right today.md section.
   **Before writing a new row or scheduling anything, run the dedup
   pre-check**:
   - Scan `<today>` `## Agent Plan` for an existing row with HH:MM
     within ±15 min AND overlapping subject/keywords. If found → skip
     (log `- HH:MM [observations] skipped <item>: already planned`).
   - Scan `<today>` `## User Tasks` for the same subject. If found →
     skip (log `skipped: already in User Tasks`).
   - For schedule registrations, also query:
     `GET /api/schedule?status=pending,running` AND
     `GET /api/recurring-schedules?enabled=true`.
     If a pending/recurring item covers the same trigger → skip.

   Only after dedup clears, route the observation:
   - New TODO for the user → append to ## User Tasks with the row shape in the
     context skill. Derive HH:MM from (a) deadline if known, (b) proximity
     to a related calendar event, or (c) working-hours midpoint.
   - New proactive reminder Claude should fire → append to ## Agent Plan AND
     register the matching POST /api/schedule in the same turn. Agent Plan rows
     and schedule entries are always in lock-step (see skill "User Tasks vs
     Agent Plan → The Agent Plan contract").
   - Day-time observation (git push, Notion status change) → append to ## Agent Notes.
5. Update projects/*.md when the observation materially changes project
   state. Do NOT write to roadmap.md from hourly — for long-horizon
   signals that don't belong in today.md but aren't yet strong enough
   for direct roadmap edits (e.g. a user edited a vault note mentioning
   a trip "sometime this summer", a far-future calendar event with an
   unclear prep window), **queue them as `roadmap_candidate`
   observations** via POST /api/observations (observations skill). The
   next roadmap_refresh run consumes them and decides routing; this
   hourly flow intentionally does not load the long-term-plan taxonomy
   at all.
   ```
   curl -s -X POST http://localhost:8321/api/observations \
     -H 'Content-Type: application/json' \
     -d '{"source":"roadmap_candidate:<subkind>","ref":"<stable-ref>","changeType":"created","actor":"agent","payload":{...}}'
   ```
   `<subkind>` examples: `travel`, `calendar`, `vault`, `dm`.
6. Skip noise: journal-only edits, trivial formatting, auto-generated churn,
   already-processed agent writes, deletion of auto-generated artifacts.
7. Mark processed observations consumed via POST /api/observations/consume.
8. Urgency gate for POST /api/notify — the default is SILENCE. At most
   ONE call per run, and only after the dedup pre-check passes AND one
   of (a)(b)(c) holds with its concrete threshold:

   **Dedup pre-check (mandatory — skip `/api/notify` if any hit):**
   - `<today>` `## Agent Log` contains a `notify sent` / `DM sent` /
     `[cal] ... — reminder sent` entry for the same item within the
     last 4 hours.
   - The truncation marker `[...N earlier entries omitted ...]` appears
     in `<today>` and you cannot rule out a same-day prior notification
     from the truncated view. In that case `GET /api/context/today`
     once for the full log before deciding.
   - A matching pending `POST /api/schedule/dm` or Agent Plan row is
     already going to fire for this item within the next 2 hours
     (prefer the planned channel — don't pre-empt it).

   **Positive triggers — at least one must hold with its threshold:**
   (a) Hard deadline ≤ 2 hours away that the agent surfaced **this
       hour** from new input (mail, DM, observation) AND the user has
       not yet acted on it. **Self-set deadlines, course assignments,
       class times, and items already in `today.md` ## User Tasks do
       NOT qualify** — they fail the awareness gate (see notify skill
       § Universal user-facing message discipline § Awareness gate).
       A 6-hour deadline is NOT urgent regardless.
   (b) Inbound DM or calendar change received in the last hour that
       needs a same-hour reply or decision from the user.
   (c) Concrete failure / blocker / conflict the user would not
       discover in time on their own (e.g. meeting moved onto an
       existing slot; CI flagged a deploy the user triggered).

   **Never urgency triggers** (log-only, no notify): "processed N
   observations", Agent Plan / schedule reshuffles, context-file
   updates, routine summaries of agent activity, roadmap candidates
   queued, observations consumed.

   When in doubt, stay silent and log.
9. Append one line to ## Agent Log even on no-op runs (Agent Log only — do
   not echo as final text, do not send via notify):
   `- HH:MM [observations] reviewed N items, added X tasks / Y plan rows, skipped Z`.
