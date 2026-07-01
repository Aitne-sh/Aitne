---
name: markdown-note
description: Canonical frontmatter + section schema + naming conventions for free-form topic notes an agent generates, so a vault stays consistent and manageable.
---

Canonical shape for free-form topic notes an agent generates, so a vault stays
consistent and manageable over time. Follow it for any note you write.

**Scope guard.** This playbook governs *free-form topic notes* an agent produces
(research write-ups, monitoring rollups, digests). It does NOT apply to the
structured context-vault files (`state/today.md`, journal, roadmap, project
indexes, etc.) — those keep their own validated schemas, owned by their skills.
Write the vault only via the daemon Context API (`/api/context/...`), never by
touching the filesystem directly.

### Frontmatter (required keys, in this order)

```
---
title: <human title>
date: <YYYY-MM-DD>
tags: [<topic>, <archetype>]
sources:
  - <url-or-label>
status: <draft | stable>
---
```

### Body sections (in order; omit a section only if truly empty)

- `## Summary` — 2–4 sentences, the takeaway up front.
- `## Key findings` — bulleted, one claim per bullet, each with a source label.
- `## Details` — per-angle / per-topic subsections as needed.
- `## Sources` — list; eTLD+1 labels or full URLs, consistently one or the other.
- `## Open questions` — what's unresolved / needs the user.

### Conventions

- Filenames: lowercase kebab-case. Dated runs: `<topic>/<YYYY-MM-DD>-<slug>.md`.
- Idempotent: a re-run updates the same file/section rather than duplicating it.
  Decide append-to-existing vs new-file-per-run once and keep it stable.
- Headings, tag vocabulary, and date format stay identical across runs so the
  vault reads as one consistent corpus, not a pile of one-off formats.
