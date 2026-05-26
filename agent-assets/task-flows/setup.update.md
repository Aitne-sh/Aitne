{context}

## Task: Update Management Rules

The user has started updating rules/management.md from the dashboard.
The current rules are included in the <management_rules> tag.

Output language: follow `<output_language_policy>` (this is a DM-style turn — match the user's input language; fall back to `<settings primary_language>` if ambiguous).

### Instructions
1. First, briefly summarize the current rules.
2. Ask the user which part they'd like to change, presenting these options:
   - **Source of Truth** — Change tools
   - **Notification Rules** — Notification timing and methods
   - **Character (tone / style / voice)** — Update the `character` runtime-config field, emitted as a ```character``` code block (NOT `policies/management.md`, NOT `identity/profile.md`)
   - **Autonomy Levels** — Agent decision scope
   - **Schedule** — Working hours
   - **Project Management** — Preferences for how the agent should handle your projects
   - **Other** — Specify freely
3. If the user changes Character, read the current value with
   `curl -s http://localhost:8321/api/config/character | jq -r .character`,
   merge the edits, and emit a ```character``` code block containing the
   new full value. Observe the 1000-char cap — surface the excess to the
   user rather than silently truncating. **Do NOT call PATCH
   /api/config/character yourself** — the dashboard persists the new
   character atomically when the user clicks Save & Finish.
4. If any management-rules sections changed, output the updated version in a ```management-rules code block.
5. If the only change was Character, still output a ```management-rules``` block containing the unchanged current rules verbatim. This is required so the dashboard can show Save & Finish; the server treats identical content as a no-op on the management file and persists only the new character value.
6. Allow **at most 2 revision rounds**.

**Do not add a tone/style section to rules/management.md, and do not write tone preferences to user/profile.md.** Tone / style / voice lives in the `character` runtime-config field only.

### Markdown formatting (the block is saved to disk verbatim)

Preserve blank lines between sections — every `##` heading and every
table must be preceded by a blank line. Never concatenate a heading
onto the end of the previous list item (e.g. `- Label: <value>## Next
Section` on one line).

### Sections to preserve byte-for-byte

When you re-emit the ```management-rules``` block, copy the following
sections from the current `<management_rules>` verbatim — they are
not part of the wizard's editable surface, and stripping them silently
breaks downstream features:

- **`## Agent Identity`** — populated by the daemon from `agentDisplayName`. Re-emit it as-is or omit it (the server upserts it on save).
- **`## Active Policies`** — a static wikilink to `policies/management-captures/_index.md` placed by skeleton seeding. Owned by the management-policy capture flow (the wizard is read-only here). If it is missing from the current rules (legacy installs), do NOT invent it; the next skeleton run will add it.

The same applies to any other section the wizard does not explicitly
ask the user about — when in doubt, copy it through unchanged.

**Important**: Outputting a ```management-rules code block triggers the dashboard to display a preview. Outputting a ```character``` code block stages the character edit into the dashboard's inline editor. The dashboard persists both on Save & Finish, so you do NOT need to call any `/api` endpoint.
