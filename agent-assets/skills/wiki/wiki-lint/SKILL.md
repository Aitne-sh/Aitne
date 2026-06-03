---
name: wiki-lint
description: Load for wiki.lint. Audits the wiki for orphans, broken links, schema drift, taxonomy candidates, and stale notes; writes a dated health report.
allowed-tools:
  - Bash(curl *)
---

# Wiki Lint

You run under process key `wiki.lint`.

Use the Wiki API to inventory the workspace and produce one health report. Never write outside the Wiki API and never modify content layers (`10_raw/`, `20_wiki/`, `30_outputs/`); the only meta surface you may write is the health report and the taxonomy candidates section.

Every request — reads and writes alike — must include `-H 'x-process-key: wiki.lint'`. See `wiki-vault-rules` for the curl-shim contract, body-quoting, and the full error-code set. `Write`/`Edit` are stripped — only `Bash(curl *)` / `Bash(jq *)` work.

## Inputs

Read the full index and recent operational history:

```
GET /api/wiki/{{workspace_name}}/index
GET /api/wiki/{{workspace_name}}/files/log.md
GET /api/wiki/{{workspace_name}}/files/90_meta/taxonomy.md
GET /api/wiki/{{workspace_name}}/files/90_meta/schemas/raw.md
GET /api/wiki/{{workspace_name}}/files/90_meta/schemas/wiki.md
GET /api/wiki/{{workspace_name}}/files/90_meta/schemas/output.md
```

Sample (do not exhaustively read) `10_raw/` and `20_wiki/` notes that look anomalous from the index alone — large size deltas, unusually old `mtime`, slugs that don't appear anywhere in `_index.md`.

## Checks

Filter the `/index` `files[]` array with `jq` (mtime / path / slug); `Bash(find/ls/cat/grep)` are denied — enumerate via `/index`, not disk.

1. **Orphans** — wiki notes (`20_wiki/<slug>.md`) that no other wiki note links to.
2. **Broken wikilinks** — `[[slug]]` references whose target file does not exist.
3. **Missing frontmatter** — notes that violate the schema in `90_meta/schemas/`.
4. **Stale content** — wiki notes whose newest source link is older than 90 days, or whose body has not changed in 180 days while the raw set behind it has grown.
5. **Term inconsistencies** — slug/title variants that look like the same concept (canonicalise via `90_meta/taxonomy.md`).
6. **Taxonomy candidates** — recurring concepts (≥3 raw notes or ≥2 wiki notes) that are not yet listed in `90_meta/taxonomy.md`.
7. **Index drift** — `20_wiki/_index.md` listing entries that do not exist on disk, or wiki notes missing from the index.

## Outputs

Write exactly one health report:

```bash
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/90_meta/health/<YYYY-MM-DD>.md \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.lint' \
  -d @- <<'JSON'
{"content":"# Wiki Health — <YYYY-MM-DD>\n\n## Summary\n..."}
JSON
```

Use today's date in `{{language}}`-neutral ISO form. The report must have these sections in order:

```
# Wiki Health — <YYYY-MM-DD>

## Summary
- one-line tally per check (e.g. "3 orphans, 1 broken link, 0 stale notes")

## Action items
- bullet list, each item names the affected file and the proposed fix

## Orphans
## Broken wikilinks
## Missing frontmatter
## Stale content
## Term inconsistencies
## Taxonomy candidates
## Index drift
```

Empty sections must still appear with `_(none)_` as the body so a downstream diff can detect the absence.

If — and only if — there are taxonomy candidates, append (`mode: "append"`) a `# Candidates` section to `90_meta/taxonomy.md`:

```bash
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/90_meta/taxonomy.md \
  -X PATCH \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.lint' \
  -d '{"mode":"append","content":"# Candidates\n- <canonical-slug> — <rationale>\n"}'
```

Each candidate line: ` - <canonical-slug> — <one-sentence rationale, references to N raw / M wiki>`. The owner reviews this section before any promotion happens; you must not move candidates into the main `## Topics` section yourself.

Append a concise `log.md` entry summarising the report ("wiki.lint: 3 orphans, 1 broken link, 2 taxonomy candidates"). If a check could not run (e.g. unreadable file), call it out explicitly in the report's `## Summary` section rather than silently dropping it.

### Completion message (mandatory)

End with one line the daemon forwards to the originating channel: `Lint complete — <Summary tally>. Report: 90_meta/health/<YYYY-MM-DD>.md.` On hard failure (no report written): `Lint failed — <reason>.` Do not paste the report.
