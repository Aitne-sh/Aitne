---
name: wiki-connect
description: Load for wiki.connect. Bridges two domains by surfacing shared terms, references, and structural analogies; writes a cited connection report to 30_outputs/.
allowed-tools:
  - Bash(curl *)
---

# Wiki Connect

You run under process key `wiki.connect`.

Read `<wiki_command>` for the two topics — fields `topic_a` and `topic_b`. Your job is to find genuine bridges between the two domains using only what the wiki contains. Speculative analogies are out of scope; if there is no real overlap, say so plainly.

## Method

1. Search each topic independently:
   ```
   GET /api/wiki/{{workspace_name}}/search?q=<topic_a>
   GET /api/wiki/{{workspace_name}}/search?q=<topic_b>
   ```
   Read enough matches to characterise each domain.
2. Surface four types of bridges:
   - **Shared terminology** — terms that appear in both domains. Use `90_meta/taxonomy.md` to disambiguate true synonyms from accidental string matches.
   - **Common references** — the same source URL, author, or wiki note linked from both domains.
   - **Structural analogies** — patterns of reasoning, tradeoffs, or recurring shapes that show up in both, even when the surface vocabulary differs.
   - **Bridging concept candidates** — a new wiki note that would naturally sit between the two (proposal only — you must not create it from `wiki.connect`).
3. Cite every bridge with at least one path from each side (`<wiki_a path>` ↔ `<wiki_b path>`). A bridge that can only cite one side is a candidate, not a bridge — file it under "Bridging concept candidates".

## Output

Write exactly one report:

```
POST /api/wiki/{{workspace_name}}/files/30_outputs/<YYYY-MM-DD>-connect-<slug>.md
x-process-key: wiki.connect
```

- `<YYYY-MM-DD>` is today's date.
- `<slug>` is `<slug-a>--<slug-b>` using the canonical slugs from `90_meta/taxonomy.md` when available, kebab-cased and joined by a double hyphen.

Report shape:

```
# Connect — <topic_a> ↔ <topic_b> (<YYYY-MM-DD>)

## Summary
- one paragraph: is there real connective tissue, weak overlap, or essentially none?

## Shared terminology
- `term` — meaning in <topic_a> vs <topic_b>, cited

## Common references
- `<source>` — used by `<wiki_a path>` and `<wiki_b path>`

## Structural analogies
- short paragraph each, both sides cited

## Bridging concept candidates
- proposed wiki slug, one-sentence rationale, suggested anchor notes
```

If no genuine bridges exist, write the report anyway with empty sections marked `_(none)_` and a `## Summary` that names that clearly — a "no connection" finding is still useful to the owner. Append a one-line `log.md` entry referencing the output filename and both topics.

### Completion message (mandatory)

End the turn with one short final assistant message that the daemon forwards back to the channel the bang command came from:

- `Connect complete — <topic_a> ↔ <topic_b>: <strong | weak | none>. Report: 30_outputs/<YYYY-MM-DD>-connect-<slug>.md.`
  - `strong` = at least one genuine bridge in any of the four buckets.
  - `weak` = only shared terminology or only candidates, no concrete cross-cited overlap.
  - `none` = the summary said so explicitly.
- On failure: `Connect failed — <one-sentence reason>.`

Do not paste bridge content into the completion message.
