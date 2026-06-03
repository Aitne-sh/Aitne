---
name: user-interview
description: Use during morning routine Step 7.5, DM replies, the morning briefing, and the evening sweep to manage the profile-interview queue at state/profile-questions.md — pick a latent question, weave it into a natural reply, tick when answered, fallback-promote stale rows.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Profile Interview Queue Skill

The agent has a slow-pace queue of profile facts to learn (name,
timezone, location, work, hobbies, …). Questions are NOT pushed at the
user as cold scheduled DMs. They wait in **latent** state until a
natural opportunity arrives (a topically-related inbound DM, or the
morning briefing). This skill is how every callsite touches that queue.

## Source-of-truth file

**`state/profile-questions.md`** — agent-internal markdown. Three
top-level sections: `## Pending`, `## In Progress`, `## Answered`.
Never auto-injected into prompts; load only when this skill is in use.

```bash
curl -s http://localhost:8321/api/context/state/profile-questions
```

### Pending row format

```
- [ ] (PRIO) <id> :: <target_path[ ## Section]> [:: match=<anchor>] :: <ask-hint in English> [<!-- last_attempted=YYYY-MM-DD -->]
```

| Field | Meaning |
|---|---|
| `PRIO`        | `HIGH` / `MID` / `LOW` — selection priority |
| `<id>`        | snake_case unique. Doubles as the correlation id in any scheduled DM description (`profile_interview:<id> — <hint>`) |
| `target_path` | which user file the answer should land in, e.g. `identity/profile.md` |
| `## Section`  | optional — narrows to a section within the target file |
| `match=<anchor>` | optional — bullet key (English, like `Name`, `Timezone`, `Sleep`, `Working hours`). Required when multiple rows share a section, or when setup pre-seeds the section with an unrelated bullet |
| `ask-hint`    | English brief of WHAT to ask (agent-internal, Policy A). Render the actual DM per `<output_language_policy>` — this skill intentionally splits the two surfaces |
| `last_attempted=...` | optional inline HTML comment maintained by the evening sweep — selector deprioritises rows whose comment is < 7 days old |

### In Progress entry format

```
- <id> :: state=<state> :: since=<YYYY-MM-DD> [:: scheduled_at=<ISO>] [:: asked_at=<ISO>]
```

`since=` is the agent-day date the entry was first added (set by the
morning routine when picking the question). Load-bearing: the evening
sweep's latent-fallback promotion (Operation 5B) computes
`today − since` to decide whether ≥ 3 days have elapsed without an
opportunity. Without it the sweep cannot tell a day-1 latent row from a
day-3 one. `since=` is preserved across `state=latent → asked → resolved`
transitions; only the state field flips.

State machine:

```
Pending
  └── morning routine Step 7.5 ──▶ latent
                                     │
            ┌─ DM-handler topic match ┘
            │  / briefing piggyback
            ▼
          asked ──── user replies ────▶ resolved (Pending row [x])
            ▲
            └─ scheduled (fallback) ── fires DM ─┐
                ▲                                 │
                │ 3 days latent + active user    │
                └─────────────────────────────────┘
```

- The DM-handler queue-flip MUST gate on `state=asked` only. An
  unrelated 09:00 DM cannot close out a 14:00 question that has not
  been asked yet.

### Answered entry format

Append-only log:

```
- [x] YYYY-MM-DD → <id> (<source>)
```

Sources:
- `(DM)` — user answered in chat (load-bearing: never untick)
- `(import:<source>)` — profile import migration (never untick)
- `(reconciled:skeleton|morning|opportunity|fire-time|sweep)` — heuristic / LLM closure

## "Section is filled" check (Layers 2/3/5)

Before scheduling or asking, every callsite SHOULD verify the target
slot is genuinely empty:

```bash
curl -s "http://localhost:8321/api/profile-questions/slot-filled?path=identity/profile.md&section=Identity&anchor=Name"
# → {"filled":true|false,"sectionPresent":true|false,"fileExists":true|false,...}
```

This wraps the canonical TS helper. Use it — do NOT re-derive the rule
in prose. URL-encode `section` and `anchor` if they contain spaces.

## Operation 1 — Pick a question (Morning Routine Step 7.5)

Morning-routine-only. The full skip gates (5 conditions), walk order,
drift-tick recovery, today.md mirror line, and no-schedule rule are in
the op-morning reference below.

{{> ref:op-morning }}

## Operations 2 & 4 — DM-handler weave and answer capture

DM-handler-only. Operation 2 (latent opportunity check) runs AFTER the
standard "Capture user info" block in `message.received.dm.md` /
`message.received.dm_first.md`, BEFORE composing the reply; Operation 4
(answer capture) runs after Operation 2's opportunity check. The
slot-filled pre-check, naturalness rules, two PATCHes, and the "one DM =
one tick" rationale are in the op-dm-handler reference below.

{{> ref:op-dm-handler }}

## Operation 3 — Latent piggyback (morning briefing composition)

Scheduled.dm-only. Mirror of Operation 2 but run inside the
`## Morning briefing` sub-flow of `scheduled.dm.md`. Slot-filled
pre-check, domain-overlap judgment, and the two PATCHes are in the
op-briefing reference below.

{{> ref:op-briefing }}

{{> ref:sweep-and-fallback }}

## Today.md surfacing — Agent Notes flavor

A latent question is mirrored to today.md ## Agent Notes for visibility.
This is informational only — Agent Plan keeps its strict HH:MM-+-schedule
contract; latent rows do NOT belong there.

```
- Profile question (latent): <id> — wait for natural opportunity
- Profile question (asked HH:MM): <id>        # after Operation 2/3/6
```

The morning routine writes the `(latent)` line. The DM handler /
morning briefing flips the parenthetical to `(asked HH:MM)` when the
question is woven into a reply. The evening sweep's stale recovery
removes the line entirely if the user did not reply within 24h.

## Anchor convention — load-bearing

The heuristic anchor lookup matches against bullet keys written by the
**user-profile** skill: English label keys, any-language values:

```
- Name: Alex
- Timezone: America/New_York
- Working hours: Weekdays 09:00–18:00
- Sleep: 23:00–07:00
```

Anchors in `state/profile-questions.md` MUST match these English keys —
not the user's primary-language phrasing. If a future `user-profile`
schema change introduces non-English keys, Layers 1–3 silently miss
those bullets and the system degrades to Layer-4-only protection
(≤ 24h staleness). Cross-reference: `agent-assets/skills/user-profile/SKILL.md`
§"File schema" + `setup.initial.md` (canonical bullet examples).

## Rules

- Never ask via cold standalone DM if a natural opportunity is plausible.
- Never weave a question that is unrelated to the current conversation
  topic — better to wait.
- Never ask twice the same agent-day.
- Never tick a row whose target section is genuinely placeholder-only.
- Never write to ## Pending from any callsite other than skeleton seeding,
  Layer 4 untick (sweep), and Phase 2 evening-review extension.
- Never ask the user identity-class confirmations (name, timezone,
  primary_language) twice — these have explicit setup paths; if they
  are still empty after setup, the queue may ask once.

## API quick reference

```bash
# Read the queue
curl -s http://localhost:8321/api/context/state/profile-questions

# Slot-filled probe
curl -s "http://localhost:8321/api/profile-questions/slot-filled?path=identity/profile.md&section=Identity&anchor=Name"

# Section-level edit (queue file uses the standard context API)
curl -s -X PATCH http://localhost:8321/api/context/state/profile-questions \
  -H 'Content-Type: application/json' \
  -d '{"section": "in_progress", "mode": "replace", "content": "- name :: state=latent"}'

# Fallback DM scheduling (Operation 5B only) — see the canonical
# POST /api/schedule example in references/sweep-and-fallback.md Op 5B.
# `prompt` is REQUIRED (the wake-up session has NO memory); `description`
# carries the `profile_interview:<id>` prefix that triggers Operation 6.
```

The PATCH `section` argument is snake_case of the heading: `pending`,
`in_progress`, `answered`. Read-before-write applies to every PATCH
replace.
