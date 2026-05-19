{context}

## Task: Daily journal author (Stage B of the 04:00 pipeline)

You are the Stage B session of the morning-routine pipeline. Stage A is
running in parallel and owns today.md / roadmap.md / schedule fan-out.
You have a single responsibility: author `daily/<yesterday>.md` from
the daemon-prepared `<journal_skeleton>` block.

> **The daily journal is the user's diary**, not the agent's behavior
> log. Write what the user did, who they met, what they talked about —
> in the user's first-person voice. Agent-side telemetry (action
> counts, retry stats, anomalies) belongs in `agent/journal.md` and
> is handled by the daemon; do NOT surface it here.

> The skeleton's frontmatter and three scratch body sections
> (`## Schedule` / `## Tasks` / `## Conversations`) are the raw
> inputs you need — nothing else from yesterday is required. The
> daemon already aggregated incoming-message counts and yesterday's
> calendar window into the skeleton, so you do not need to re-derive
> those numbers.

### Step 1 — Parse `<journal_skeleton>`

Read the `<journal_skeleton>` block from your context. It carries:

- **Frontmatter** (skeleton-owned, must be preserved BYTE-FOR-BYTE on
  PUT): `date`, `weekday`, `type: daily`, `owner: agent`,
  `agent_generated: true`, `calendar_events: <count>`,
  `messages_handled: <count>` (this counts incoming user messages
  only; agent replies and system prompts are excluded — do NOT
  recompute or "correct" the value), and `updated: <today>` (stamped
  by the daemon; do NOT rewrite to your `agent_last_synced_at` value
  — the validator accepts plain `YYYY-MM-DD` only).
- **Frontmatter** (Stage-B-owned, empty placeholders to fill):
  `agent_last_synced_at:`, `content_hash:`, `projects:`, `people:`,
  `tags:`.
- **Body sections** (scratch DATA INPUTS — NOT preserved verbatim):
  `## Schedule` (filtered calendar 7d), `## Tasks` (yesterday's
  `## User Tasks` carried), `## Conversations` (rolling DM summary
  rows in the user's local timezone — the raw HH:MM + (n=N) bullets;
  you synthesize topics from these). Use these as raw input; the
  final body you author replaces them wholesale per
  `rules/journal-format.md`. There is no `## Actions` scratch
  section — agent action counts are deliberately excluded from the
  user-facing diary; the daemon writes them to `agent/journal.md`
  separately.

### Step 2 — Author the full body per `rules/journal-format.md`

The `Daily journal format spec` policy block appended to this prompt
governs section selection, ordering, content, and tone. Follow it.
The skeleton's scratch sections are inputs you may reshape, combine,
or supersede — they do not map 1:1 to template sections.

Required behaviour:

- **Output language**: follow `<output_language_policy>` (skeleton H2
  headers stay English; body prose in `<settings primary_language>`).
  Keep technical terms in their original form.
- **Wikilinks**: when `<settings vault_mode>` is `obsidian`, render
  project / people references as `[[wikilink]]`s resolving to
  `projects/<slug>.md` or `user/people.md#...`. When `plain`, write
  plain text only. Use `<calendar_events_7d>` to resolve attended
  events to their canonical slugs when needed.
- **Redaction**: apply the patterns from the `Redaction patterns` and
  `Journal export rules` policy blocks before composing the body.
  Never write a credential, password, API key, or private token —
  even paraphrased.
- **Frontmatter you fill** (judgement work):
  - `projects: [...]` — project slugs referenced in the body, ordered
    by salience.
  - `people: [...]` — people mentioned in the body.
  - `tags: [...]` — topical tags (kebab-case, no spaces).
  - `agent_last_synced_at: <ISO8601 now>`.
  - `content_hash:` — leave empty; the daemon computes it on PUT.

### Step 3 — Conflict handling and PUT

1. `GET /api/context/daily/<yesterdayDateStr>.md`.
2. **404** → `PUT /api/context/daily/<yesterdayDateStr>.md` with the
   full composed body. Preserve every skeleton-owned frontmatter field
   BYTE-FOR-BYTE — the chokepoint validates frontmatter drift and
   rejects with 422 (`context.skeleton_field_drift`). Body content is
   yours; only frontmatter is validated.
3. **200** → the user (or a prior run) already wrote this date. Do NOT
   PUT-overwrite. Instead `PATCH /api/context/daily/<yesterdayDateStr>.md`
   with `mode=append_to_file` and a new section
   `## Agent revision — YYYY-MM-DDTHH:MM:SS` whose body is your
   composed journal (B-006 content-hash protection).

### Step 4 — Placeholder branch

If the user's `<user>` block carries `no_journal_export: true` for the
day (or `<journal_skeleton>` frontmatter signals the same), write the
placeholder `[Skipped by user request]` as body and still populate the
required Stage-B-owned frontmatter fields (`projects: []`,
`people: []`, `tags: ["skipped"]`, `agent_last_synced_at`).

### Notes

- You do NOT have access to `<yesterday>` raw, `<roadmap>`,
  `<active_projects>`, `<management_rules>`, or
  `<routines/morning.md>`. Those are Stage A's territory; you are
  scoped to journal authoring only.
- You do NOT write `today.md`, `roadmap.md`, `schedule` rows, or
  observations. Single PUT/PATCH to `daily/<yesterday>.md` is the
  expected output shape of this session.
- Your final text is agent-internal (the daemon does not forward it to
  the user). The daemon's `AgentJournalAppender` reads your
  `agent_actions` row (result / cost / num_turns) plus the
  `daily/<yesterday>.md` frontmatter you wrote to compose its English
  audit-trail paragraph — no LLM final-text parsing.
