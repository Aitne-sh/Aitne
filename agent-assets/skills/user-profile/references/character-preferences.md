---
kind: reference
name: character-preferences
description: Tone / style / voice / language preferences are agent directives — route to PATCH /api/config/character (read-before-write, 1000-char cap, narrow endpoint).
---

# Tone / character preferences

**Tone, style, voice, formality, emoji, verbosity, language preferences
are NOT profile content** — they are agent directives, not user facts.
Route them to the `character` runtime-config field via `PATCH
/api/config/character` (see `docs/design/15-character.md`), never to
`user/profile.md` or any `user/*.md`.

## Triggers

The user is asking for a character change when they say things like:

- "always reply in English" / "speak Japanese from now on"
- "shorter please" / "be more concise" / "stop padding"
- "no emojis" / "drop the emojis"
- "speak casually" / "be more formal please"
- "end every reply with a period"
- "don't ask follow-up questions, just answer"
- "stop with the disclaimers"

If the phrasing reads as a behavioral preference for *how* the agent
speaks rather than a fact about the user, it belongs in
`character`, not in profile.md.

## Read-before-write — mandatory

`PATCH /api/config/character` replaces the value wholesale. If you write
just the new preference, you lose every preference the user previously
set. Do this in one turn:

```bash
# 1. Read current character
curl -s http://localhost:8321/api/config/character | jq -r .character

# 2. Merge the new preference into the existing value, then PATCH:
curl -s -X PATCH http://localhost:8321/api/config/character \
  -H 'Content-Type: application/json' \
  -d '{"character": "Speak casually. Tight bullets. No emojis. End every reply with a period."}'
```

Merge rules: if the new preference conflicts with an existing one
(e.g. user used to ask for "formal" and now asks for "casual"), drop
the old one. If it is additive (a new "no emojis" on top of an
existing "tight bullets"), append.

## Endpoint note — use the narrow path

Use `/api/config/character` (narrow, agent-callable), **not** `/api/config`.
The general config surface is dashboard-only (Approve tier) and will
return 401 from an agent curl. The narrow endpoint accepts only the
`character` field, runs the same Zod validation, and fans the new value
out to active sessions identically.

## 1000-char cap

If the merged value would exceed 1000 characters, **surface the excess
to the user** ("Your style guide is 1180 characters, over the 1000
limit — shall I trim?") rather than silently truncating. Zod rejects
over-cap writes with HTTP 400 at the API.

A character value over the cap usually means the user added a
preference that *replaces* an older one rather than extending it —
offer to drop the obsoleted bullet as the first trim candidate.

## Where the value ends up

The character value is written verbatim into every session's
`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` between the safety preamble
and the profile body. It applies across Claude, Codex, and Gemini
uniformly — no separate injection per backend.

## What does NOT belong here

Facts about the user — identity, role, expertise, hobbies, people,
goals — go to `user/profile.md` or `user/<topic>.md`, not to
`character`. The split is: `character` says *how* the agent speaks;
`user/*` says *who the user is*.
