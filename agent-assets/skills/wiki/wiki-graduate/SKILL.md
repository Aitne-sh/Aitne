---
name: wiki-graduate
description: Load alongside wiki-compile. Promotes ready inbox material into a real wiki note with the canonical schema; never invents content beyond the source.
allowed-tools:
  - Bash(curl *)
---

# Wiki Graduate

You are loaded alongside `wiki-compile` so a compile pass can promote a single inbox note or output artifact into a real `20_wiki/<slug>.md` article when the source has matured enough.

`00_inbox/` is **read-only** to agents (`wiki-vault-rules` §Layers). You may read inbox material, but the only legal write surface for the graduated article is `20_wiki/` via the Wiki API. Never write back into `00_inbox/`.

## When to apply

A source qualifies for graduation only if all of these are true:

1. The user explicitly referenced it as a candidate (e.g. via a graduate task body in `<wiki_command>`), OR the compile pass identified the same idea across ≥3 raw notes that converge on a stable framing.
2. The synthesis would not duplicate an existing `20_wiki/<slug>.md`.
3. The source contains enough substantive content (>200 words of original facts/argument) to warrant a wiki note — short links and bookmarks do not graduate.

If any of these fail, skip the graduation and leave a note in `log.md`: "wiki.graduate skipped: <slug> — <reason>".

## Method

1. Read the source path. Inbox paths look like `00_inbox/<anything>.md`; output paths look like `30_outputs/<YYYY-MM-DD>-<slug>.md`.
2. Extract the substantive ideas. Preserve quoted source text verbatim; paraphrase only the user's own commentary.
3. Apply the wiki schema (`90_meta/schemas/wiki.md`): summary → key facts → source links → related notes. Include frontmatter that names the source path under `derived_from:` and dates the promotion under `graduated_at:`.
4. Link to existing related wiki notes using `[[slug]]` syntax. Use the canonical slug from `90_meta/taxonomy.md` when available.
5. Update `20_wiki/_index.md` so the new article is discoverable.

## Write path

```
POST /api/wiki/{{workspace_name}}/files/20_wiki/<slug>.md
PATCH /api/wiki/{{workspace_name}}/files/20_wiki/_index.md (mode: "append")
x-process-key: wiki.compile
```

Use `wiki.compile` as the process key — graduation is a sub-action of the compile pass, not a separate process. If the slug collides with an existing wiki note, append a year disambiguator (`<slug>-<YYYY>`) only as a last resort; prefer extending the existing note via `wiki-compile` itself.

Append a `log.md` entry: "wiki.graduate: promoted `<source path>` → `20_wiki/<slug>.md`".

End with a short internal summary only.
