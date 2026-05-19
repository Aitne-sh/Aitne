---
type: rule
slug: journal-export
owner: user
updated: 2026-04-17
template_version: 1
---
# Journal export rules

Edit this file to control what's included when the agent mirrors your
synthesized `daily/*.md` entries to an external backend (B-005). These
rules run *on top of* the built-in `rules/redaction.md` patterns.

## Inclusion defaults

By default everything in `daily/<date>.md` is exported. Override per
section below.

## Exclusion rules (user-editable)

List sections or patterns to strip before export:

- (none yet)

## Per-day opt-out

If you want a specific day skipped entirely, add
`no_journal_export: true` to that day's `daily/<date>.md` frontmatter.
The agent writes the placeholder `[Skipped by user request]` instead of
a full body.

## Target-specific overrides

When multiple journal backends are enabled (e.g., Obsidian + filesystem),
sub-sections below can scope rules to one target. Format:

```
### target: <obsidian | filesystem | project-root>
- rule 1
- rule 2
```
