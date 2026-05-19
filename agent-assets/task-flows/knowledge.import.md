{context}

## Task: Knowledge Import — write user-supplied facts into `user/*.md`

The user has uploaded a single Markdown or text file from the dashboard Knowledge page. Your job is to read it and route its facts into the appropriate `user/*.md` files **without changing what the user wrote**. The CLAUDE.md / AGENTS.md / GEMINI.md materialized for this session contains your full Profile Importer persona — re-read it before writing if you're unsure.

The event payload (substituted into this prompt) carries:
- `{event_data[scratchPath]}` — context-relative path of the scratch copy of the upload (e.g. `agent/scratch/import-2026-04-27-<id>.md`)
- `{event_data[filename]}` — the original filename
- `{event_data[importSource]}` — origin label the user picked (`obsidian-export`, `notion-export`, `self-written`, `other`). Note: `event_data[source]` is the daemon-side event source (e.g. `"dashboard_knowledge_upload"`), not what the user selected — use `importSource`.
- `{event_data[uploadDate]}` — ISO date string for the closing journal entry

### Step 1 — Read the upload (verbatim)

```
curl -s "http://localhost:8321/api/context/{event_data[scratchPath]}"
```

The response is JSON; the `content` field is the literal source text. Every fact you write to `user/*.md` must be traceable to a line in this file.

### Step 2 — Hard stop on secret-shaped content

If the source contains any of:
- `-----BEGIN ... PRIVATE KEY-----`
- AWS keys (`AKIA[0-9A-Z]{16}`), Google API keys (`AIza[0-9A-Za-z_-]{35}`), GitHub tokens (`gh[pousr]_[A-Za-z0-9]{36,}`), or Slack tokens (`xox[abp]-`)
- Lines that look like `password:` / `secret:` / `token:` followed by a non-empty value

ABORT the import. Do not write anything to `user/*.md`. Notify the owner via `/api/notify` (the `notify` skill is loaded for this exact purpose):

```
curl -s -X POST http://localhost:8321/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"message": "Knowledge import refused — the upload contained content shaped like a private key, API token, or credential. No files were modified. Please remove the sensitive content and re-upload.", "priority": "normal"}'
```

Then append this entry to `agent/journal.md` using `mode: "append_to_file"` (each journal entry is its own top-level `## ` section):

```
curl -s -X PATCH http://localhost:8321/api/context/agent/journal \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg c '
## {event_data[uploadDate]} knowledge import REFUSED (source={event_data[importSource]}, file={event_data[filename]})
- Reason: secret-shaped content at line N
- No files modified.' '{mode:"append_to_file", content:$c}')"
```

Then end the session.

### Step 3 — Discover the knowledge layout

```
curl -s "http://localhost:8321/api/context/list/user"
```

The response shape is `{"files": [{"name": "profile.md", "lastModified": "..."}, ...]}`. Build a Set of existing topic file basenames (`profile`, `people`, `work`, `expertise`, `personal`, `goals`, plus any others present). Treat this Set as authoritative — only read or PATCH files in this Set.

If the listing is empty (no `user/*.md` files exist at all), the user has not completed initial setup. ABORT with a journal entry "skeleton not seeded — initial setup incomplete" and end the session. (The route layer also gates this, so this is a defense-in-depth check.)

### Step 4 — Read each existing target file once

For every basename in the Set from Step 3, fetch the body:

```
curl -s "http://localhost:8321/api/context/user/<basename>"
```

You need the current body to:
1. Skip facts that are already present (substring or near-substring match — be conservative; skip on doubt).
2. Detect conflicts (existing bullet contradicts source bullet — see Step 6).
3. Discover the file's existing `## Section` headings (you'll need these for PATCH `section` parameters in Step 6).
4. Preserve the file's frontmatter and section structure.

### Step 5 — Classify each source fact and route

Standard routing (see also `user-profile` skill):

| Class | Target |
|---|---|
| Identity (legal name, primary timezone, primary language, DOB) | **DO NOT WRITE.** Collect verbatim for the Step 8 journal entry under "Identity-class facts awaiting confirmation". The dashboard surfaces these for explicit accept/reject — they never auto-land in `user/profile.md`. |
| Relationships (family, partners, close friends) | `user/people.md` |
| Work / employer / role / colleagues | `user/work.md` |
| Skills, expertise, languages spoken | `user/expertise.md` |
| Lifestyle, hobbies, preferences, health | `user/personal.md` |
| Goals, aspirations, current focus | `user/goals.md` |

Routing rules:
- If the natural target file is **missing from the Step 3 Set**, route the fact to `user/profile.md` instead and prefix its bullet with `[from <missing-file>]` (e.g. `- [from work.md] Works at Acme.`) so the user can later move it. Skip the route only if `user/profile.md` itself is also missing — in that case Step 3's empty-listing abort already fired.
- If a fact does not fit any class, append it to `user/profile.md` in a section named `## Misc` (verbatim — no parens, no date in the heading, because `normalizeSection` does not preserve them). Date the bullet inline: `- [imported {event_data[uploadDate]}] <verbatim line>`.

### Step 6 — Apply writes (verbatim, append-only) via section PATCH

`PATCH /api/context/<path>` operates on a single `## Section`, NOT on the full file body. The schema is:

```
{
  "section": "<snake_case_of_heading>",                          # e.g. "## Family" → "family", "## Roles" → "roles"
  "mode":    "append" | "replace" | "clear" | "append_to_file",  # use "append" for facts; never "replace" here
  "content": "- <verbatim bullet>"                               # multiple bullets joined with \n
}
```

For each target file with at least one new fact:

1. `curl -s "http://localhost:8321/api/context/user/<topic>"` once. From the body, list every existing `## ` heading and the bullets they contain. You'll use this to (a) skip duplicates, (b) pick a section name, (c) detect conflicts.

2. Group new facts by destination section. Each bullet must be a **verbatim** copy of a line from the source — strip only leading list markers (`- `, `* `, `1. `) and surrounding whitespace. Skip any line whose substance is already present in the target section.

3. For each (section, bullets) group, PATCH with `mode: "append"`. Multiple bullets go in ONE call, joined by `\n`:

```
curl -s -X PATCH http://localhost:8321/api/context/user/<topic> \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s 'family' \
                --arg c '- Sister (Sarah): two kids as of 2026-04
- Mother Yoko (1955–)' \
              '{section:$s, mode:"append", content:$c}')"
```

4. **`section_not_found` fallback.** If the response is `{"error": "section_not_found"}`, the section does not exist yet. Retry with `mode: "append_to_file"` and put the heading into the content (with a leading newline so it lands on its own line):

```
curl -s -X PATCH http://localhost:8321/api/context/user/<topic> \
  -H 'Content-Type: application/json' \
  -d '{"mode": "append_to_file", "content": "\n## Family\n- Sister (Sarah): two kids as of 2026-04"}'
```

The next PATCH to `section: "family"` on the same file then succeeds normally.

5. **Conflict handling.** If a source bullet contradicts an existing bullet in some section, DO NOT touch the original section. Instead, append the source bullet to a separate `## Pending Conflicts` section on the same file, with each bullet prefixed `- [imported {event_data[uploadDate]}] ` so the date stays inline. First write to that section uses the `append_to_file` fallback (with content `\n## Pending Conflicts\n- [imported {event_data[uploadDate]}] <bullet>`); subsequent writes use `mode: "append"` with `section: "pending_conflicts"`. Note each conflict in the closing journal entry.

6. **Never use `mode: "replace"` in this flow.** Replace overwrites the entire section body and would erase facts that aren't in the import. Append-only is the strict-fidelity guarantee.

7. **404 handling.** If a GET or PATCH responds with `{"error": "not_found"}` (the file vanished between Step 3 and Step 6), drop that file from the run, count its facts under "Skipped — file_not_found" in the closing journal entry, and continue with the remaining files. Do not retry, do not create the file with PUT — file creation is the setup wizard's job, not this session's.

### Step 7 — Identity-class deferral

This is a no-write step. From the source, collect every Identity-class fact (legal name, primary timezone, primary language, date of birth, primary email, primary phone) into a list, **verbatim**. Do NOT PATCH them anywhere. The Step 8 journal entry surfaces them under "Identity-class facts awaiting confirmation"; the dashboard reads that section to offer the user an explicit accept/reject decision later. Identity-class fields are too high-stakes to land in `user/profile.md` from an import.

### Step 8 — Closing journal entry

After all PATCHes succeed, append exactly one entry to `agent/journal.md`. Each journal entry is its own top-level `## ` section, so use `mode: "append_to_file"` and embed the heading in the content (leading `\n` so it lands on its own line):

```
curl -s -X PATCH http://localhost:8321/api/context/agent/journal \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg c '
## {event_data[uploadDate]} knowledge import (source={event_data[importSource]}, file={event_data[filename]})
- Wrote <N> facts to <comma-separated file paths>
- Skipped <M> lines — reasons: <ambiguous=A, already-present=B, identity-class-deferred=C>
- Pending conflicts: <list of file:section pairs, or "none">
- Identity-class facts awaiting confirmation: <verbatim list, or "none">' '{mode:"append_to_file", content:$c}')"
```

Then end the session. No DM (other than the Step 2 abort notification when applicable), no follow-up schedule, no other writes.

### Reminders

- The persona file (CLAUDE.md / AGENTS.md / GEMINI.md depending on this session's backend) is the source of truth for fidelity rules. Re-read its "non-negotiable rule" section if you find yourself wanting to "polish" a bullet.
- Read the target file once before writing — needed to dedupe, to pick the right section name, and to detect conflicts. PATCH itself is section-targeted and does not require `expectedMtime` (that is the PUT contract; ignore it here).
- Group bullets by section: one PATCH per (file, section), with multiple bullets joined by `\n` in `content`. Do not send one PATCH per bullet.
- `mode: "append"` only. Never `mode: "replace"` on existing sections — that would erase the user's prior facts.
