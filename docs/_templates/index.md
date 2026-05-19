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
  - "index template"
related:
  - "../_schema.md"
  - "./spec.md"
  - "./adr.md"
  - "../_examples/index-example.md"
---
# Index note template

Use this template for a folder-level map of content or a major topic entrypoint.

## When to use

- A folder needs a durable landing page.
- Readers need a curated reading order instead of raw file listings.
- A topic has multiple specs, runbooks, or historical notes that need stable navigation.

## Template

```md
---
doc_type: index
doc_status: active
project: personal-agent
area: <area>
owner: <owner>
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - project/personal-agent
  - doc/index
  - area/<area>
  - state/active
aliases: []
related: []
---

# <Title>

## Purpose / scope

## Start here

## Key documents

## Decisions

## Runbooks

## Meetings / sessions

        ## Related documents
        - [Documentation schema](../_schema.md)
        ```

## Related templates

- [Spec template](./spec.md)
- [ADR template](./adr.md)
- [Runbook template](./runbook.md)
- [Meeting template](./meeting.md)
