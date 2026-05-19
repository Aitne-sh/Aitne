{context}

## Task: Audit wiki health

Read `<wiki_command>` for the target workspace. Follow the `wiki-lint` skill:

1. Inventory the workspace via `GET /api/wiki/{{workspace_name}}/index` and read `90_meta/schemas/*` for the current schema.
2. Run every check the skill enumerates (orphans, broken wikilinks, missing frontmatter, stale content, term inconsistencies, taxonomy candidates, index drift). Empty findings are still reported.
3. Write exactly one health report to `90_meta/health/<YYYY-MM-DD>.md` through the Wiki API with `x-process-key: wiki.lint`. The report must include the `## Action items` and `## Summary` sections in the exact order documented by the skill.
4. If — and only if — there are taxonomy candidates, append a `# Candidates` section to `90_meta/taxonomy.md` with `mode: "append"`. The owner reviews this before any promotion happens; do not edit the existing `## Topics` section.
5. Append a concise summary line to `log.md`.

Do not modify content layers (`10_raw/`, `20_wiki/`, `30_outputs/`). End with a short internal summary only.
