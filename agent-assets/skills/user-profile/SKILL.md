---
name: user-profile
description: Record user facts — identity, people, work, expertise, habits, goals, tendencies. Top-level → identity/profile.md; detail → identity/<topic>.md. Tone/style/voice/language are NOT facts — route to PATCH /api/config/character. Same turn as reply. Skip dupes. Never notify.
allowed-tools:
  - Bash(curl *)
  - Read
---

# User Profile Update Guide

Output language: `identity/profile.md` and `identity/*.md` are Policy B — see `<output_language_policy>`. Template H2 headers stay English skeleton; the facts under them are in `<settings primary_language>`. Preserve user-customized headers verbatim.

`identity/profile.md` stores the user's identity, preferences, and learned behavioral patterns. It is injected into every agent session via `<user>` tags — keep it concise (target: under ~600 tokens total).

Detailed, dictionary-like background belongs under `identity/*.md`. Read `identity/_index.md` first, then fetch only the topic file you need.

## When to Update

**Immediately (same turn) when the user shares:**
- Identity or role — "I'm a …", "I work at …", "my title is …" → `profile.md ## Identity`
- People they know — names + relationship, e.g. "my sister", "my manager Sarah" → `identity/people.md`
- Workplace specifics — company, team, tech stack, tools — "I use Postgres at work" → `identity/work.md`
- Expertise or tools they use habitually — "I've been writing Go for ten years", "I'm new to React" → `identity/expertise.md` (add a one-line summary in `profile.md ## Expertise` when the fact also shapes how the agent should explain things)
- Hobbies, habits, health, lifestyle (factual) — "I run every morning", "I don't eat meat" → `identity/personal.md`
- Goals or learning targets — "I want to get better at Rust", "I want to read 20 books this year" → `identity/goals.md`
- A notification or day-type preference — "no work notifications on weekends" → `profile.md ## Notification Preferences`
- A self-reported behavioral pattern the agent should adapt to — "I'm not a morning person", "I tend to skim long messages" → `profile.md ## Learned Context` with today's `[YYYY-MM-DD]` prefix

**Do NOT update for:**
- One-off requests — "just for this reply, use English"
- Information already present in the target file (read-before-write)
- Speculative inferences — only save what the user stated
- Ephemeral facts (mood, current project name that could change tomorrow)

**Routing edge cases** (for shapes the trigger list above doesn't disambiguate):
- "my name is Alex" — explicit identity statement goes to `profile.md ## Identity`, not a topic file.
- "user has been unusually curt over the last week" — a pattern inferred across multiple turns with no single user statement. Written to `profile.md ## Learned Context` by Evening Review Step 3a only; the DM handler and sweep do not write inferred patterns.
- "my sister just had a baby" → `identity/people.md ## Family`. If the section doesn't exist yet (fresh topic file with only the H1), the PATCH returns `section_not_found` — retry with `mode: "append_to_file"` and include `"\n## Family\n- <bullet>"` in `content`. The next write to that section succeeds normally.

The decision rule (profile.md vs `identity/<topic>.md` tie-breakers, `section_not_found` → `append_to_file` first-write fallback, and the read-before-write `curl` recipe) is documented in full in this skill — see §"Section ownership", §"File schema", and §"Worked example" below.

## Section ownership

Per-section trigger → destination → writer is in the auto-curated **When-to-update routing** block below. Writer notes layered on top:

- "DM handler" covers both `message.received.dm` and `message.received.dm_first`. "Sweep" is `routine.user_profile_sweep` (fires 03:50 and 17:50 local; see its task-flow). Evening Review Step 3a is an additional writer to Learned Context only, synthesizing entries from Raw Signals graduation.
- **Do not write to Raw Signals from other events — that section is `SignalDetector`'s alone.**

## identity/profile.md vs identity/<topic>

**identity/profile.md** — injected every session: Identity, Work Pattern, Platforms, Expertise summary, Notification Preferences, Learned Context.

**identity/*.md** — dictionary-like (`people` | `work` | `expertise` | `goals` | `personal`), too detailed for every session. Read `identity/_index.md` first → fetch only the relevant topic. Per-topic ownership is in the auto-curated **Knowledge map** block below.

## File schema

All `identity/*.md` files must keep YAML frontmatter with `type: user`,
`owner: shared`, and `updated: YYYY-MM-DD`, followed by an H1. When using
section-level PATCH, preserve the existing frontmatter. When doing a
full-file PUT, update `updated` to today's date.

**Bullet key convention — load-bearing.** Bullets under each H2 use
**English label keys**, any-language values:

```
- Name: Alex
- Timezone: America/New_York
- Working hours: Weekdays 09:00–18:00
```

The `user-interview` skill's queue (`state/profile-questions.md`)
matches against these English keys. If you introduce a non-English
label here, the queue's slot-filled probe silently misses the bullet
and re-asks the same question on the next opportunity. See
`user-interview/SKILL.md` §"Anchor convention — load-bearing".

## Notification Preferences format

Morning Routine reads this daily to derive today.md's day-type filter. Keep bullets machine-parseable:

```
## Notification Preferences
- Weekdays (Mon–Fri): work on, study on, personal on
- Weekends (Sat–Sun): work off, study on, personal on
- Quiet hours: 22:00–08:00
- Do not notify during meetings
```

Omitted categories default to `on`. [home] follows [personal].

If the user says "I don't want work notifications on weekends", paraphrase into `- Weekends (Sat–Sun): work off, personal on`.

## Tone / character preferences

**Tone, style, voice, formality, emoji, verbosity, language
preferences are NOT profile content.** Route them to the `character`
runtime-config field via `PATCH /api/config/character` (narrow
endpoint, 1000-char cap, read-before-write). Never write tone /
style preferences into `identity/profile.md` or any `identity/*.md`.

Full recipe — triggers, merge rules, endpoint note, cap-handling, and
where the value ends up — is in the character-preferences reference
below.

{{> ref:character-preferences }}

## Read-before-write — mandatory for PATCH replace

See _safety.md "Common Patterns" for the general rule. Section name in PATCH is **snake_case** of the heading — e.g. "Learned Context" → `learned_context`.

### Worked example

User: `"I want to read 20 books this year."` → GET identity/profile.md (or topic file), merge new bullet into the right section. For a top-level goal summary bullet:
```bash
curl -s -X PATCH http://localhost:8321/api/context/identity/profile \
  -H 'Content-Type: application/json' \
  -d '{"section": "learned_context", "mode": "append", "content": "- [2026-04-23] Reading goal: 20 books/year"}'
```
For a full-section replace, GET first, merge with existing bullets, then PATCH with `mode: "replace"` carrying the full merged body.

**WRONG** (erases existing bullets): `curl -s -X PATCH ... -d '{"section": "learned_context", "mode": "replace", "content": "- [2026-04-23] Reading goal: ..."}'` when the section already held other bullets.

For writes to `identity/<topic>.md` (people / work / expertise / personal / goals), the same decision rule applies — §"Routing edge cases" above documents the `section_not_found` → `append_to_file` first-write fallback (with a worked `curl` example against `identity/people.md`). The read-before-write rule applies identically when merging into an existing `identity/<topic>.md` section.

## Learned Context entry format

Always prefix Learned Context entries with `[YYYY-MM-DD]` so the Evening
Review can prune entries older than 30 days:

```
## Learned Context
- [2026-04-01] Prefers concise bullet points over paragraphs
- [2026-04-08] Deep TypeScript expertise — frame explanations at expert level
```

**Refresh the prefix on merge.** When a writer (DM handler or sweep) merges a new statement into an existing Learned Context bullet — for example, the user restates "I tend to skim long messages" or clarifies a prior preference — rewrite the `[YYYY-MM-DD]` prefix to today's date rather than preserving the original. A restatement is evidence the preference is still live, so the 30-day pruning timer should reset. This is Learned-Context-specific; other sections without a date prefix follow the normal byte-for-byte preservation rule on merge.

## Rules

- **Silent updates.** Never notify the user about profile changes.
- **Keep concise.** 2–5 bullets per section max. Consolidate similar bullets.
- **No duplicates.** Scan before adding. Prefer refining an existing bullet.
- **Total budget ~600 tokens** for identity/profile.md. Consolidate aggressively.
- **Don't write verbatim user messages.** Paraphrase into stable preference statements.

## Initial Setup

Populate `identity/profile.md` (Identity, Work Pattern, Platforms, Expertise summary, Notification Preferences — leave Learned Context/Raw Signals empty). Read skeleton first → prefer `mode: "append"` → `mode: "replace"` only for full merged body. Tone / style preferences do NOT go into profile.md — see §"Tone / character preferences".

*During setup, seed `identity/profile.md` only. The topic files (`identity/people.md`, `work.md`, `expertise.md`, `personal.md`, `goals.md`) stay empty and grow from lived conversation via the DM handler and `routine.user_profile_sweep`.*

---

## API Reference

The generic GET / PATCH surface (modes, fields, error envelopes) is
documented in the **context** skill `references/api.md`. user-profile
writes target the two paths `/api/context/identity/profile` (the injected
summary file) and `/api/context/identity/:topic` (one of `people` /
`work` / `expertise` / `personal` / `goals`).

Two user-profile-specific notes layered on top of the generic surface:

- **`clear_before` on `## Raw Signals`** is the race-safe consumption
  path Evening Review uses to drain Raw Signals without dropping
  concurrent appends. Pass a SQLite-format `cutoff`:

  ```bash
  curl -s -X PATCH http://localhost:8321/api/context/identity/profile \
    -H 'Content-Type: application/json' \
    -d '{"section": "raw_signals", "mode": "clear_before", "cutoff": "2026-04-10 02:33:00"}'
  ```

- **`maxEntries`** on `## Raw Signals` append is the SignalDetector's
  cap (= 20). Other writers do not set it.

## Knowledge map — topic files (auto-curated)

<!-- CURATION:knowledge_layout id="topic-files" -->

## When-to-update routing (auto-curated)

<!-- CURATION:routing_table id="routing-table" -->

## Learned Context conventions (auto-curated)

<!-- CURATION:convention_notes id="learned-context-format" -->
