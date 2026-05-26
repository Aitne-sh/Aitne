---
type: rule
slug: journal-format
owner: user
updated: 2026-05-16
template_version: 3
---
# Daily journal — format template

This file controls how the agent writes `daily/YYYY-MM-DD.md` during the
04:00 morning routine. Edit this file to change the format. The agent
reads it as a **format spec** (body structure, required/optional sections,
voice) — it does NOT follow this as code; natural-language guidance is
fine.

## Framing — this is the user's diary

`daily/<date>.md` is the **user's diary**, not the agent's behavior
log. It records the user's day: what the user did, what the user
talked about, what was on their schedule. The agent is the author
because the human user doesn't journal by hand — but the perspective,
voice, and content all belong to the user.

Agent-side bookkeeping (action counts, internal anomalies, audit
trail) lives in `journal/agent.md` — not here. If you find yourself
about to log "the agent ran N tools today" or "the hourly check
fired M times", that belongs in the agent-side log instead. Filter
it out.

The daemon's `journal-skeleton-builder`
(`docs/design/appendices/morning-routine-optimization.md` §"Daemon-side
modules to add" — Phase 2 daemon primitive) emits scratch data
(`## Schedule`, `## Tasks`, `## Conversations`) read from SQLite +
yesterday.md. Stage B **authors the entire body** per the section
list below, using the scratch sections as input data — the skeleton
sections are NOT preserved verbatim. Only the skeleton-owned
frontmatter MUST be preserved byte-for-byte; the daemon's daily-write
chokepoint validates frontmatter drift with
`context.skeleton_field_drift` and rejects the PUT with 422. Body
content (section names, ordering, prose) is Stage B's responsibility
and not validated for drift.

## Required frontmatter fields

Skeleton-owned (preserved byte-for-byte by Stage B):
- `date`, `weekday`, `type: daily`, `owner: agent`, `agent_generated: true`
- `calendar_events: <count>` — total calendar events filtered to the
  agent-day window
- `messages_handled: <count>` — **incoming user messages only**
  (`messages.role='user'` rows within the agent-day window). Agent
  replies and internal `system` rows are excluded so the value
  matches "how many messages did the user send today" rather than
  total conversation turns. (Field name kept for backward
  compatibility with already-written daily journals; a future rename
  to `messages_received` is deferred.)
- `updated: <YYYY-MM-DD>` — today's agent-day, stamped by the daemon
  at skeleton-build time. The generic context-frontmatter validator
  requires this field on every `daily/*.md` PUT; emitting it from the
  daemon (instead of leaving it as a Stage-B placeholder) eliminates
  the 422 failure mode where Stage B forgot to fill the slot.

Stage B-owned (filled from the narrative Stage B authors):
- `agent_last_synced_at` (ISO 8601), `content_hash` (`sha256:<hex>`)
- `projects: [...]`, `people: [...]`, `tags: [...]`

## Required body sections (Stage B output order)

Stage B authors each section below. Annotations describe the scratch
data Stage B reads from the daemon-emitted skeleton; the skeleton
section names happen to match the output section names, but Stage B
remains free to reshape data, add bullets, drop a section on a sparse
day, etc.

1. `# YYYY-MM-DD (Weekday)` — title. Stage B emits verbatim from the
   skeleton's title line.
2. `## Summary` — **one paragraph, 3–5 sentences, first-person voice
   from the user's perspective**. Authored entirely by Stage B (no
   skeleton placeholder). Placed first so the reader's eye lands on
   the narrative synthesis before the raw-fact sections that follow
   (TL;DR-at-top reading order matching the pre-rev2 daily journal
   corpus the user has accumulated). The voice is **the user's**, not
   the agent's — "I shipped X", "I met with Y", "I felt rushed about
   Z". Don't write about what the agent did ("the agent triaged 4
   inbox items") — that's footprint, not diary content.
3. `## Schedule` — yesterday's events the user attended (or had
   planned). Each line is `- HH:MM — <title>` for timed events, `-
   <title>` for all-day. `- (none)` when the day carried no events.
   Stage B reads the skeleton's `## Schedule` scratch section as
   input; may add `(attended)` / `(skipped)` flags from yesterday
   context.
4. `## Tasks` — yesterday's `## User Tasks` carried forward, checkbox
   markers stripped, `(none)` placeholder filtered. These are the
   things the user was meant to do — keep them user-side (not
   agent-side schedule rows). `- (none)` when yesterday had no User
   Tasks. Stage B reads the skeleton's `## Tasks` scratch section as
   input.
5. `## Conversations` — **what the user talked about that day**, as
   topic-level bullets. Stage B reads the skeleton's
   `## Conversations` scratch section (rolling DM summaries with
   HH:MM + message counts) and synthesises **2–5 topic bullets** in
   the user's voice, e.g. `- Discussed Q2 roadmap with the agent —
   agreed to defer feature X`. The HH:MM and `(n=N)` markers from
   the scratch input are NOT preserved verbatim; they're inputs for
   topic synthesis, not output structure. `- (none)` when no DM
   activity. Skip mechanical per-thread enumeration — collapse to
   topics.

**Sections deliberately NOT in the daily journal:**

- ❌ Agent action counts (`agent_actions` breakdown by type). Lives
  in `journal/agent.md` instead — the audit-trail footprint.
- ❌ Internal stage status, retry counts, anomalies. Same as above.
- ❌ "The agent did X for the user" framing. The user's diary uses
  user voice; agent meta-narration belongs in the agent-side log.

## Voice (`## Summary` and `## Conversations`)

- First-person **from the user's perspective** ("I shipped...", "I
  met with...", "I asked the agent about..."), concise, factual
- Written in `settings.primary_language`; keep technical terms in their
  original form if that's how the user writes them
- Refers to the entities Stage B surfaces in the body sections that
  follow (the meetings under `## Schedule`, the tasks under
  `## Tasks`, the topics under `## Conversations`) so the narrative
  reads as a synthesis of those facts, not a separate stream of
  consciousness

## Wikilink rendering

- When `settings.vault_mode` is `obsidian`, Stage B renders project /
  people references throughout the body as `[[wikilinks]]` targeting
  `projects/<slug>.md` or `identity/people.md#<person>` (basename resolves
  automatically). The `## Summary` paragraph is the primary surface,
  but data sections may also receive wikilinks where a project / person
  name appears (e.g. a meeting title containing a person's name).
- When `vault_mode` is `plain`, Stage B writes plain text only — no
  double brackets, no link markup.
- The skeleton's scratch sections do not embed wikilinks; Stage B
  applies them as it authors the final body.

## Redaction

- Apply `policies/redaction.md` patterns to the entire body Stage B
  authors (Summary + data sections both — Stage B owns the body, so
  redaction applies wherever sensitive content might surface).
- Apply `policies/journal-export.md` user rules to the entire body.
- If yesterday.md frontmatter had `no_journal_export: true`, write
  `[Skipped by user request]` as the body of `## Summary` and omit
  the data sections (they would echo information the export rule is
  trying to suppress).

The skeleton's scratch sections carry data sourced from upstream
writers (calendar observer, yesterday.md `## User Tasks`, the
`dm_conversation_log` rolling-summary writer). Stage B SHOULD apply
redaction during authoring; but the *primary* defence belongs
**upstream** — if a credit-card number is appearing in
`dm_conversation_log` summaries, fix the rolling-summary writer
rather than relying on Stage B as the last line of defence. Stage
B's redaction is a backstop, not a safety net.

## Conflict behavior

Follow B-006 content-hash protection: if the user edited the previous
day's `daily/<date>.md`, append `## Agent revision — <ISO timestamp>`
rather than overwrite. The Agent revision section may carry a fresh
Summary + any updated data sections. The original body the user
edited is preserved verbatim above the Agent revision boundary;
Stage B does NOT rewrite sections the user touched.
