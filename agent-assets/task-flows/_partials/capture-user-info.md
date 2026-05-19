---
# capture-user-info — canonical trigger-shape enumeration + routing rules
# for silent same-turn user-info writes. Included from:
#   - message.received.dm.md (Step 1)
#   - message.received.dm_first.md (Step 1)
#   - routine.user_profile_sweep.md (Step 2)
#   - routine.evening_review.md (Step 3 cross-reference)
# Source of truth: this partial. The user-profile skill is the writer
# (file split, read-before-write, section_not_found fallback, anchor
# convention); this partial is the trigger-and-routing summary the
# task-flows consume.
---

Scan for declarative user facts or imperative tone/style directives. If matched, persist in the **same turn** — silent (no acknowledgement to the user); do not defer to Evening Review (the message may be truncated by then).

**Imperative tone/style directives** ("always reply in English", "shorter please", "don't add emojis", "speak casually", "be more concise") are agent directives, NOT user facts → route per the user-profile skill §"Tone / character preferences". When ambiguous (e.g. "I prefer short replies"), default to character — never duplicate in profile.md.

**Declarative facts about the user** → route through the user-profile skill. The skill owns the trigger shapes, the file split (`profile.md` vs `user/<topic>.md`), the read-before-write contract, the `section_not_found` → `append_to_file` first-write fallback, and the Learned-Context-vs-personal.md disambiguator. Key calls:

- Top-level identity / platform / notification fact → `user/profile.md`.
- Detail-heavy fact (specific person, workplace, hobby, tool, goal) → matching `user/<topic>.md` (`people` / `work` / `expertise` / `personal` / `goals`).
- Self-reported behavioral pattern the agent should adapt to ("I'm not a morning person") → `user/profile.md ## Learned Context` with today's `[YYYY-MM-DD]` prefix.

Never invent facts the user did not state. Never re-write a fact a paraphrase of which already exists in the target file.
