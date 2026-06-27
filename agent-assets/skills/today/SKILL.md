---
name: today
description: Load for any event that reads or writes today.md — morning routines, activity scans, DMs, scheduled tasks. Owns the day-type filter, Agent Plan contract, Agent Log/Notes schema, schedule.approaching format, and Morning Routine lock.
allowed-tools:
  - Bash(curl *)
  - Read
---

# today.md Guide

Output language: today.md is Policy B — see `<output_language_policy>`. The skeleton (line 1, line 2, the six H2 headers) stays English verbatim — line 1 and line 2 are exact-regex-validated on PUT; bullets and narrative under each H2 are in `<settings primary_language>`. §Line 1 and §Header line carry the exact patterns and the consequence of translating a line-2 keyword.

today.md has a **day-type header line** (second line) and **six required sections**.

```
# YYYY-MM-DD (day-of-week)
> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on

## User Schedule
## User Tasks
## Agent Plan
## Agent Notes
## Agent Log
## Handoff
```

## Line 1 — which date?

Always copy the date from the prompt's `<current_agent_day date="…" weekday="…" boundary_hour="…" />`.
That attribute is the **agent-day date**, not the calendar date — they
diverge between local midnight and `boundary_hour:00` local. Use the
attribute value verbatim:

```
# <current_agent_day.date> (<current_agent_day.weekday>)
```

So when the prompt context contains
`<current_agent_day date="2026-04-28" weekday="Tuesday" boundary_hour="4" />`,
line 1 is exactly `# 2026-04-28 (Tuesday)`. Do **not** advance the date
because the routine is "preparing tomorrow"; the morning routine always
prepares the agent-day in progress, not the next one.

`PUT /api/context/state/today` returns 400 (`error:"validation_error"`) if
line 1 disagrees with the daemon's current agent-day; the error message
echoes both values so a mistake is recoverable in the same session.

today.md has **no YAML frontmatter** — the H1 must be the first byte of
the file.

## Header line — day-type filter

Line 2 encodes today's filter policy (field order is fixed — downstream parsers rely on it):

```
> Day type: {Weekday|Weekend} | Work focus: {on|off} | Study focus: {on|off} | Personal focus: {on|off}
```

The field labels (`Day type`, `Work focus`, `Study focus`, `Personal
focus`), the values (`Weekday`/`Weekend`, `on`/`off`), the ` | `
separators, and the leading `> ` are all English ASCII, fixed casing,
fixed spacing — exact-regex-validated. **Translating any line-2 keyword
into the primary language is the most common write failure: PUT is
rejected 400 and the file is not written.** Keep line 2 English even
when the rest of today.md is in another language.

Derivation, focus-dimension mapping, and downstream focus-filter usage —
needed only when the Morning Routine writes line 2 — are in the
**today-skeleton** reference.

Line 2 is not frozen for the day: when the user declares a day-shape
change ("taking the afternoon off", "sick today"), the DM handler
updates the matching focus value(s) in place — exact format above,
English keywords. PATCH targets sections only and cannot reach line 2:
GET `/api/context/state/today`, edit line 2 alone, PUT the full
document straight back. Fire-time filters then suppress or re-admit
whole categories; never hand-edit individual rows for a focus change.

## Sections and entry formats

The per-section update matrix (when/mode/who-writes) and the
per-section entry-format table (User Schedule / User Tasks / Agent Plan
/ Agent Log row shapes, category tags, trigger tags, mandatory-HH:MM
fallback rules) are reference-grade detail the Morning Routine needs to
write the full skeleton. They live in the **today-skeleton** reference.

{{> ref:today-skeleton }}

## User Tasks vs Agent Plan

User Tasks = things the **user** will do.
Agent Plan = things **Claude Code** will do to help the user.

## Agent Plan contract

1. Every Agent Plan row MUST be backed by exactly one `POST /api/schedule` that fires at the stated HH:MM.
2. Every planned outbound reminder/DM/check-in MUST appear as a row so the user can audit it.
3. When the scheduled wake-up fires, the handler MUST close the loop (see lifecycle below).

Violations: row without schedule → silently never fires. Schedule without row → invisible work. Past `[ ]` row → bug or de-registered.

## Agent Plan lifecycle — close the loop

`scheduled.task` and `scheduled.dm` (and any other event that flips an
Agent Plan row) follow the close-the-loop lifecycle in the reference
below: execute, append Agent Log entry, read-then-flip the row to
`[x]` with annotation, retry on `state/today.md` lock, surface missing-row
state.

DM handlers and activity scans never flip rows for execution outcomes —
their only row write is the cancel / amend revision below.

{{> ref:agent-plan-lifecycle }}

## Agent Plan revision — cancel / amend before fire time

When a pending row's premise dies or its time must change before it
fires, the session that detects it — DM handlers and activity scans
included — revises schedule + row + Agent Log in the same turn:

{{> ref:agent-plan-revision }}

## Agent Log format

`- HH:MM Action description`. Log every user-visible action, context file write, or outbound API call. Skip purely internal no-ops.

## Agent Notes flavors

- **Look-ahead** (Morning Routine): `- [ ] (HIGH/MID/LOW) description — reasoning`
- **Day-time observations**: `- Source: summary of notable change`
- **Latent profile question** (Morning Routine Step 7.5):
  `- Profile question (latent): <id> — wait for natural opportunity`
  Flipped to `- Profile question (asked HH:MM): <id>` by the DM
  handler / morning briefing when the question is woven into a reply.
  Not an Agent Plan row — does NOT carry a leading HH:MM and is NOT
  backed by a schedule entry. The question is opportunistic, not
  scheduled. The parenthetical `(latent)` / `(asked HH:MM)` is the
  state field; the LLM finds the line by matching the
  `Profile question (latent): <id>` prefix. See the **user-interview**
  skill for the full lifecycle.

## schedule.approaching → Agent Notes + Agent Log

The firing flow gates timing — `schedule.approaching` only fires at
`minutesUntil <= 15` (`packages/daemon/src/observers/imminent-event-scheduler.ts:281`),
so the LLM never sees this format-using event with a wider lookahead.
No additional gate is restated here.

**Agent Notes**:
`- event_title starts at HH:MM [— blocks/relates to: <task>]`

**Agent Log** (always):
`- HH:MM [cal] event_title — action`

## Morning Routine lock

Morning Routine acquires exclusive lock. Other sessions get 409 on PUT/PATCH (GET always allowed). If `<today_write_lock_id>` is in context, include `X-Lock-Id` header on every PUT/PATCH. Lock auto-releases on daemon timeout.

PUT today.md must contain the H1 date line, day-type header quote, and all six sections in order.

## today.md API

The generic GET / PUT / PATCH / DELETE shape lives in the **context** skill `references/api.md`. today.md adds only the Morning Routine lock (§Morning Routine lock) and the line-1/line-2 skeleton validators (§Line 1, §Header line) detailed above.

## Knowledge map — section shape (auto-curated)

<!-- CURATION:knowledge_layout id="section-shape" -->

## Agent Notes flavors (auto-curated)

<!-- CURATION:convention_notes id="agent-notes-flavors" -->
