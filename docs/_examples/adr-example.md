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
  - "adr example"
related:
  - "../_schema.md"
  - "../_templates/adr.md"
  - "./index-example.md"
  - "./spec-example.md"
---
# ADR-001 — Use relative Markdown links in note bodies

## Summary

Use relative Markdown links instead of vault-specific wiki links for all body content.

## Context

The docs need to stay readable in Obsidian, GitHub, IDE previews, and terminal tooling.

## Decision

Body links use relative Markdown links. Aliases handle search ergonomics in Obsidian.

## Alternatives considered

- Obsidian wiki links: convenient in-vault, but weaker portability.
- Absolute repository URLs: stable in GitHub, noisy in local tools.

## Consequences

- Renames must update links immediately.
- Search stays strong because aliases and index notes remain available.

## Open questions

- Whether automated link validation should run in CI.

## Related documents

- [Documentation schema](../_schema.md)
- [ADR template](../_templates/adr.md)
- [Index example](./index-example.md)
- [Spec example](./spec-example.md)
