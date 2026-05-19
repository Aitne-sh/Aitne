---
doc_type: index
doc_status: active
project: personal-agent
area: docs-system
owner: aitne
created: 2026-04-17
updated: 2026-05-18
tags:
  - "project/personal-agent"
  - "doc/index"
  - "area/docs-system"
  - "state/active"
aliases:
  - "docs home"
  - "documentation index"
related:
  - "./_schema.md"
  - "./setup-guide.md"
  - "./troubleshooting.md"
  - "./maintenance.md"
  - "./advisor.md"
---
# Documentation index

`docs/` is the operator-facing documentation root for Aitne. The structure prioritises standard Markdown, relative links, and predictable frontmatter so the same files stay readable in Obsidian, GitHub, IDEs, and CLI tools.

The architectural specification lives in source — `packages/daemon/src/` is the authority when this doc and the implementation disagree. Top-level project framing is in [README.md](../README.md).

## Start here

- [Setup guide](./setup-guide.md) — end-to-end install + integration walkthrough
- [Troubleshooting guide](./troubleshooting.md) — diagnostics and recovery
- [Maintenance playbook](./maintenance.md) — what files to edit together when models, plans, skills, or integrations change
- [Advisor](./advisor.md) — the in-session server-side reviewer tool
- [Documentation schema](./_schema.md) — frontmatter contract for every file under `docs/`

## Reusable note skeletons

- [Templates index](./_templates/index.md)
- [Spec template](./_templates/spec.md)
- [ADR template](./_templates/adr.md)
- [Runbook template](./_templates/runbook.md)
- [Meeting template](./_templates/meeting.md)

## Filled examples

- [Examples index](./_examples/index.md)
- [Index example](./_examples/index-example.md)
- [Spec example](./_examples/spec-example.md)
- [ADR example](./_examples/adr-example.md)

## Conventions

- The common metadata contract lives in [docs/_schema.md](./_schema.md).
- All operator-facing prose is **English**. Skill / task-flow / agent-profile content under `agent-assets/` is English-only too.
- Memory tree, write semantics, and the four integration modes are documented in [setup-guide.md](./setup-guide.md).

## Related documents

- [Documentation schema](./_schema.md)
- [Setup guide](./setup-guide.md)
- [Troubleshooting guide](./troubleshooting.md)
- [Maintenance playbook](./maintenance.md)
- [Advisor](./advisor.md)
