---
doc_type: reference
doc_status: active
project: personal-agent
area: docs-system
owner: aitne
created: 2026-04-17
updated: 2026-04-17
tags:
  - "project/personal-agent"
  - "doc/reference"
  - "area/docs-system"
  - "state/active"
aliases:
  - "docs schema"
related:
  - "./index.md"
  - "./_templates/index.md"
  - "./_examples/index-example.md"
---
# Documentation schema

## Property list

All Markdown notes in `docs/` use the same frontmatter keys in this order:

```yaml
---
doc_type:
doc_status:
project:
area:
owner:
created:
updated:
tags: []
aliases: []
related: []
---
```

| Property | Type | Required | Notes |
|---|---|---|---|
| `doc_type` | enum | Yes | One of the defined note types below. |
| `doc_status` | enum | Yes | Lifecycle state of the note itself, not the feature. |
| `project` | string | Yes | Repository-level project identifier. Use `personal-agent`. |
| `area` | string | Yes | Stable topical area in kebab-case. |
| `owner` | string | Yes | Current owner for maintenance. |
| `created` | date | Yes | `YYYY-MM-DD`. For migrated legacy notes, use the best known original date; if unavailable, use the migration date. |
| `updated` | date | Yes | `YYYY-MM-DD`. Update whenever the note changes materially. |
| `tags` | list[string] | Yes | Broad categories only. |
| `aliases` | list[string] | Yes | Old names, abbreviations, or common search terms. |
| `related` | list[string] | Yes | Relative paths to closely related notes. |

## Enum list

### `doc_type`

- `index`
- `brief`
- `spec`
- `adr`
- `runbook`
- `meeting`
- `session`
- `reference`

### `doc_status`

- `draft`
- `review`
- `active`
- `superseded`
- `archived`

## Note type guidance

- `index`: map of content for a folder or major topic.
- `brief`: concise overview, proposal, roadmap, audit, or historical summary.
- `spec`: design intent, behavior, constraints, or implementation contract.
- `adr`: durable decision record with context, alternatives, and consequences.
- `runbook`: operational procedure with validation and rollback.
- `meeting`: notes from a meeting with decisions and action items.
- `session`: working log for an implementation or investigation session.
- `reference`: lookup-oriented material such as API, schema, configuration, or supporting data.

## Naming rules

- Frontmatter keys use `snake_case` only.
- `area` uses a stable kebab-case topic name, not a sentence.
- `project` is stable across the vault unless a file truly belongs to another project.
- Do not add new frontmatter keys until this schema is updated first.

## File naming rules

- New note filenames use `kebab-case`.
- Folder map notes use `index.md`.
- ADR notes prefer `adr-001-short-name.md` when a numbered ADR series is started.
- Avoid generic names unless the file is intentionally an index or a template.
- If a file is renamed or moved, update all affected links in the same change.

## Link principles

- Use relative Markdown links in note bodies.
- Prefer stable file links over fragile heading links.
- Add a `Related documents` section near the end of important notes.
- Do not repeatedly link the same term on one page.
- Keep Obsidian usability by adding aliases, but keep the body portable Markdown first.

## Tags principles

Use a small, consistent tag set:

- `project/<name>`
- `doc/<type>`
- `area/<name>`
- `state/<status>`

Prefer explicit links for relationships. Tags are for broad filtering, not graph modeling.

## Templates and examples

- Templates: [index](./_templates/index.md), [spec](./_templates/spec.md), [adr](./_templates/adr.md), [runbook](./_templates/runbook.md), [meeting](./_templates/meeting.md)
- Examples: [index example](./_examples/index-example.md), [spec example](./_examples/spec-example.md), [ADR example](./_examples/adr-example.md)

## Related documents

- [Documentation index](./index.md)
- [Index template](./_templates/index.md)
- [Index example](./_examples/index-example.md)
