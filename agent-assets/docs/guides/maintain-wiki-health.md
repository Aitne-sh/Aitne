---
schema_version: 1
slug: guides/maintain-wiki-health
title: Maintain Wiki Health
id: maintain-wiki-health
aliases:
  - "!lint"
  - wiki health
  - wiki lint
  - wiki orphans
  - wiki taxonomy candidates
category: guides
summary: |
  How to run `!lint`, read the health report, act on action items,
  and review taxonomy candidates the wiki agent surfaces for owner
  approval before promoting them.
section: maintain-wiki-health
tags:
  - guides
  - wiki
  - health
status: stable
ask_examples:
  - How do I run a wiki health check?
  - What does the wiki health report contain?
  - Where do I see the latest health report?
  - How often should I run !lint?
  - What is a taxonomy candidate?
locale: en-US
created: 2026-05-12
updated: 2026-06-07
keywords:
  - wiki health
  - wiki lint
  - wiki maintenance
  - wiki freshness
  - orphan notes
  - taxonomy candidates
related:
  - features/wiki/overview
  - features/wiki/commands
  - features/wiki/cost-and-approval
  - guides/explore-with-trace-and-connect
process_keys:
  - wiki.lint
  - wiki.compile
  - wiki.ingest_url
  - wiki.ask
  - wiki.trace
api_endpoints:
  - /api/wiki/:workspace/files/:path{.+}
  - /api/wiki/:workspace/health
ui_anchors:
  - /wiki
  - /wiki/timeline
  - /settings/wiki
  - /settings/wiki/timeline
---

# Maintain Wiki Health

The wiki is a living artifact. Notes accumulate, sources drift,
slugs collide, and the taxonomy slowly diverges from the vocabulary
your raw notes actually use. `!lint` is the periodic audit pass
that surfaces all of this in one report — without changing your
notes itself.

## When to Run

`!lint` runs on the `wiki.lint` process key (medium tier — Sonnet
by default, $0.50 budget envelope) and never changes your notes.
Run it whenever you want a snapshot of wiki health. A practical
cadence:

- **Weekly**, after a busy ingest week, to catch orphans early.
- **Before promoting a candidate** to the taxonomy or graduating
  an inbox note — you want the audit fresh.
- **After a bulk import** (Phase 2 migration or a backlog
  `!ingest` batch) to verify the merge didn't introduce drift.

You don't need to schedule `!lint`; send it from a DM:

```
!lint
```

The wiki agent replies with the workspace name and tells you the
report will land at `90_meta/health/<today>.md`.

## What the Report Contains

The report is a Markdown file at `90_meta/health/<YYYY-MM-DD>.md`
with a fixed section order:

1. **Summary** — one-line tallies (`3 orphans, 1 broken link, 2
   taxonomy candidates`).
2. **Action items** — concrete fixes you can take, each naming
   the affected file and the proposed change.
3. **Orphans** — wiki notes with no incoming links.
4. **Broken wikilinks** — `[[slug]]` references pointing at files
   that no longer exist.
5. **Missing frontmatter** — notes that don't satisfy the schema
   in `90_meta/schemas/`.
6. **Stale content** — wiki notes whose newest source link is
   older than 90 days.
7. **Term inconsistencies** — slugs that look like the same
   concept under different names.
8. **Taxonomy candidates** — recurring concepts that aren't yet
   in `90_meta/taxonomy.md` (three or more raw notes, or two or
   more wiki notes).
9. **Index drift** — `20_wiki/_index.md` mismatches against disk.

Empty sections render as `_(none)_` so a diff between two reports
makes the change visible.

## Reading the Report on the Dashboard

Open **My Life → Wiki → Timeline & health** (`/wiki/timeline`). The
page is also reachable from a button at the top of `/settings/wiki`,
and the same view is mirrored under `/settings/wiki/timeline`. The
most-recent report is parsed and rendered with:

- A coloured date badge.
- The `## Summary` bullets.
- The `## Action items` list (this is the part you actually act on).
- A "View full report" expander showing the raw Markdown for
  every section.

The same page hosts the activity timeline (see below) so you can
correlate a health finding with the ingest / compile / ask runs
that produced the state.

## Acting on Action Items

The audit never modifies content layers itself. For each action
item:

- **Orphan** → either link the note from `20_wiki/_index.md` and
  related notes, or archive it. From a DM you can run `!ask` to
  decide whether the note's content has been superseded.
- **Broken wikilink** → edit the linking note via `!compile` (so a
  fresh `wiki.compile` resolves the reference) or trace the
  history with `!trace` to recover what the missing target used
  to be.
- **Stale content** → re-ingest authoritative sources with `!ingest`,
  then run `!compile` to re-synthesize.
- **Term inconsistencies** → decide on the canonical slug, then
  update `90_meta/taxonomy.md` manually so future ingests pick the
  right name.

For example, if the report flags `formal-methods.md` as an orphan,
you might first ask the agent whether it still matters, then either
link it or archive it:

```
!ask Is formal-methods still relevant, or has it been folded into another note?
```

If the answer says it's superseded, archive the note; otherwise add
a `[[formal-methods]]` link from a related article and re-run
`!compile` so the index picks it up.

## Taxonomy Candidates

When `!lint` finds a concept appearing repeatedly that isn't yet
in the taxonomy, it appends a `# Candidates` section to
`90_meta/taxonomy.md`:

```
# Candidates
- quantum-computing — referenced by 4 raw / 0 wiki
- formal-methods — referenced by 3 raw / 1 wiki
```

**The wiki agent never promotes a candidate into the main `##
Topics` section itself.** Promotion is an owner act because once a
slug is canonical, every future ingest and compile pass will route
toward it. To promote, edit `90_meta/taxonomy.md` directly:

1. Move the candidate line into the `## Topics` section.
2. Delete the corresponding line from `# Candidates`.
3. Optionally add aliases for spelling variants the raw notes use.

The next `!compile` will reconcile existing notes against the new
canonical slug.

## Where the Report Lives

The report is a regular wiki file written via the standard
chokepoint, so:

- It's visible to `!ask` (you can literally ask "what did the last
  lint find?").
- The DM read-only surface
  (`GET /api/wiki/:workspace/files/90_meta/health/<date>.md`) serves
  it back to a DM-agent for follow-up questions.
- Internal-mode workspaces snapshot the previous version into
  `.snapshots/` before each rewrite; external-mode relies on your
  git or cloud sync.
