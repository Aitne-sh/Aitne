---
name: today
description: Load for any event that reads or writes today.md — morning routines, hourly checks, DMs, scheduled tasks. Owns the day-type filter, Agent Plan contract, Agent Log/Notes schema, schedule.approaching format, and Morning Routine lock.
allowed-tools:
  - Bash(curl *)
  - Read
---

# today.md Guide

Output language: today.md is Policy B — see `<output_language_policy>`. The skeleton lines listed below stay English verbatim; bullets and narrative under each H2 are in `<settings primary_language>`.

**Skeleton (do NOT translate — exact-regex-validated on PUT):**

1. **Line 1** — `# YYYY-MM-DD (day-of-week)` H1 date line. The weekday
   inside `(...)` is free-form and may be localized; the rest is fixed.
2. **Line 2** — `> Day type: …` blockquote (full pattern below). Field
   labels (`Day type`, `Work focus`, `Study focus`, `Personal focus`),
   values (`Weekday`/`Weekend`, `on`/`off`), pipe separators (` | `),
   and the leading `> ` are **all English ASCII, fixed casing, fixed
   spacing**. This is parsed by every downstream event handler.
3. **The six H2 headers** — `## User Schedule`, `## User Tasks`,
   `## Agent Plan`, `## Agent Notes`, `## Agent Log`, `## Handoff` —
   in this order.

A `PUT /api/context/state/today` whose line 1 or line 2 fails the exact regex
is rejected with 400 and the daemon does NOT write the file. Translating
any keyword on line 2 (the field labels, the `Weekday`/`Weekend` value,
or `on`/`off`) into the user's primary language is the most common
failure mode — keep it English even when the rest of today.md is being
written in another language. The `<output_language_policy>` skeleton
precedence rule already covers this; this paragraph just makes the
consequence explicit.

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

Derivation (Morning Routine at 04:00):
1. Day-of-week from `<current_time>`. Weekday = Mon–Fri, Weekend = Sat–Sun (unless user/profile.md overrides).
2. Read `identity/profile.md` → ## Notification Preferences. Apply matching policy.
3. No explicit policy → default: weekday = all on, weekend = work off, study on, personal on.

Category → focus-dimension mapping:

| Category tag | Controlled by |
|---|---|
| `[work]` | Work focus |
| `[study]` | Study focus |
| `[personal]`, `[home]` | Personal focus |

How downstream events use it:
- Morning Routine suppresses items with focus `off` at generation time
- scheduled.task re-checks at fire time: if focus is off, skip + close as `skipped (focus off)`
- DM handler skips follow-ups on rows whose focus is off
- Hourly check drops observations whose focus is off
- schedule.approaching suppresses notifications for off categories

## Sections and when to update

| Section | When to update | Mode | Who writes |
|---|---|---|---|
| `user_schedule` | Morning from calendar; refresh after sync | PUT (Morning) / PATCH replace | Morning primary |
| `user_tasks` | Status changes, new tasks, hourly observations | PATCH append (new) / replace (flip) | Morning + event-driven |
| `agent_plan` | Morning lays out actions; hourly adds new; scheduled.task flips `[x]` | PATCH append / replace (flip) | Morning + hourly + scheduled.task |
| `agent_notes` | Look-ahead + day-time events | PATCH append | Morning (look-ahead) + event-driven |
| `agent_log` | Every non-trivial agent action | PATCH append | All events |
| `handoff` | Evening Review finalizes carry-overs | PATCH replace | Evening Review only |

## Entry formats

| Section | Format | Example |
|---|---|---|
| `user_schedule` | `- HH:MM[–HH:MM] <title> [category]` | `- 14:00–15:00 Design review [work]` |
| `user_tasks` | `- [ ] HH:MM <description> [category]` | `- [ ] 11:00 Finalize Q2 draft [work]` |
| `agent_plan` | `- [ ] HH:MM <action> [category] →<trigger>` | `- [ ] 08:55 DM reminder: standup [work] →DM` |
| `agent_notes` | see flavors below | |
| `agent_log` | `- HH:MM <action description>` | `- 13:50 [cal] Design review — reminder sent` |

**Category tags**: `[work]`, `[study]`, `[personal]`, `[home]` — mandatory on Agent Plan rows (not decorative).

**Trigger tags** (Agent Plan only): `→DM`, `→notify`, `→check-in`, `→wake`

**HH:MM is mandatory** on User Tasks and Agent Plan rows. If no natural time: (1) deadline → 2h before, (2) calendar-adjacent → 15 min before, (3) otherwise → working-hours midpoint.

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

DM handlers and hourly checks do not flip Agent Plan rows — read the
reference only if your event type is in its applicability list.

{{> ref:agent-plan-lifecycle }}

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
`minutesUntil <= 15` (`packages/daemon/src/observers/calendar-poller.ts:125`),
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

The generic GET / PUT / PATCH / DELETE surface — modes, fields, error
envelopes, body-submission shape — is documented in the **context**
skill `references/api.md`. today.md-specific rules layered on top:

- **Lock.** `state/today.md` is locked by the Morning Routine. Include
  `X-Lock-Id: <today_write_lock_id>` on every PUT / PATCH when the
  tag is in your context; other sessions get `409
  morning_routine_lock_held` while the lock is held.
- **Skeleton validators.** PUT is rejected (400) if line 1 fails the
  H1 date regex or line 2 fails the day-type quote regex (see §"Line 1
  — which date?" and §"Header line — day-type filter" above). PUT is
  also rejected (400) if line 1's date disagrees with the daemon's current
  agent-day — the error echoes both values.

## Knowledge map — section shape (auto-curated)

<!-- CURATION:knowledge_layout id="section-shape" -->

## Agent Notes flavors (auto-curated)

<!-- CURATION:convention_notes id="agent-notes-flavors" -->
