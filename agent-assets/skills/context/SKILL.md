---
name: context
description: Load when reading or writing project notes, weekly/monthly summaries, or agent/journal.md. Owns GET/PATCH for context files except today.md and roadmap.md, which use their dedicated skills.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Context File Update Guide

Output language: context files are Policy B — see `<output_language_policy>`. Preserve user-customized headers verbatim (whichever language the user rewrote them in).

Context files are the agent's working memory, stored in the **primary
management vault**. All writes go through the Daemon API — never touch
files on disk directly.

`/api/context/*` is the **only legal write path to the primary vault**,
regardless of where that vault physically lives: whether it is
`~/.personal-agent/context/` (plain mode) or a user-chosen Obsidian-style
directory (obsidian mode, `primaryVaultPath`). Never write to those paths
directly via `Edit` / `Write` / shell redirects, and never reach them via
`/api/obsidian/*` — that endpoint targets a **separate external Obsidian
vault**, not this primary store.

## File responsibilities

| File | Purpose | Owner | Lock? |
|---|---|---|---|
| `state/today.md` | Today's schedule, tasks, agent log, handoff | See `today` skill | Yes (Morning Routine) |
| `plans/roadmap.md` | Long-horizon agent action plan + Long-term Plans | See `roadmap` skill | Yes (Roadmap Refresh) |
| `projects/*.md` | Project state summaries | Any event on material state change | No |
| `weekly/YYYY-Www.md` | Weekly review snapshots | Friday Weekly Review only (PUT) | No |
| `monthly/YYYY-MM.md` | Monthly review snapshots | Month-end Monthly Review only (PUT) | No |
| `rules/*.md` | User-controlled policy files | Explicit user request only | No |
| `policies/management-captures/<slug>.md` | Durable management policies captured from DM | `management-policy` skill — **do not write from here** | No |
| `policies/management-captures/_index.md` | Readable index of active policies | `management-policy` skill — **do not write from here** | No |
| `routines/*.md` | Per-cadence check rulebooks | Explicit user request only | No |
| `identity/profile.md` | User identity and preferences | `user-profile` skill — **do not write from here** | No |
| `user/*.md` | Detailed user dictionary | `user-profile` skill — **do not write from here** | No |

Morning Routine scans roadmap daily and processes matching Preparation
Timeline rows into `state/today.md` — see the `roadmap` skill for the full
entry taxonomy and the morning routine task-flow for the scanning rules.

## projects/*.md

Update on status changes, milestones reached/delayed, or active set changes. Use `GET /api/context/list/projects` to discover files. The source of truth is always the individual `projects/<slug>.md` notes; `_active.base` is only the Obsidian Bases view config, not a narrative summary note.

The canonical frontmatter schema is documented in `plans/projects/_index.md`
(seeded from `agent-assets/templates/plans/projects/_index.md`). The API
validates only `type: project`, `owner: shared`, `updated`, and an H1
(`context-frontmatter.ts`). Conventional but unvalidated fields —
`slug`, `state`, `start`, `due`, `stakeholders`, `next_milestone`,
`tags` — should still be written for new files because the
`plans/projects/_active.base` Obsidian view filters on `state`.

## Project DM-intent detection

DM-driven project state writes are dispatched from
`message.received.dm.md` / `message.received.dm_first.md` Step 4 via
the `_partials/dm-intent.project.md` task-flow partial — that partial
carries the decision tree (existing-vs-new match, decline-marker
pre-check, no-match confirm sub-flow scheduling, reply branches,
cross-path cancellation, slug grammar, tie-breakers).

**This skill is the writer.** `projects/<slug>.md` PUT / PATCH / archive
goes through `/api/context/projects/*` per the API Reference below. The
partial dispatches; this skill executes the writes.

Cross-references previously in this section ("Reply branches",
"Cross-path cancellation", "Decline-marker reversal", "Tie-breakers",
"Slug grammar") now live alongside their decision-tree steps inside
the partial.

## Snapshot files — weekly / monthly / rules / routines

Weekly and monthly review snapshots, the user-controlled `rules/*.md`
policy files, the built-in `routines/<cadence>.md` rulebooks, custom
routines under `policies/routines/custom/`, and the agent-private
`journal/agent.md` all have stable per-file conventions (writer event,
verb, frontmatter, retention) documented in the snapshot-files
reference below.

DM handlers and Hourly Checks should generally not write these files
— the cadence-matching routine is the right writer.

{{> ref:snapshot-files }}

## Required frontmatter for guarded files

Full-file writes to `user/*.md`, `rules/*.md`, `projects/*.md`,
`daily/*.md`, `weekly/*.md`, and `monthly/*.md` must open with the
matching YAML frontmatter (`type`, `owner`, `updated`) followed by at
least one H1 heading. Per-glob values and the common rejection
envelope are in the required-frontmatter reference below.

{{> ref:required-frontmatter }}

## API Reference

The full `/api/context/*` surface — read / write / list / lock /
archive / restore / health / repair / action-log — is organised by
operation in the reference below. Add `X-Lock-Id` on every PUT / PATCH
to `state/today.md` (`<today_write_lock_id>`) or `plans/roadmap.md`
(`<roadmap_write_lock_id>`) when the matching lock-id tag is in your
context.

{{> ref:api }}

## Knowledge map — file responsibilities (auto-curated)

<!-- CURATION:knowledge_layout id="file-responsibilities" -->

## Knowledge map — frontmatter requirements (auto-curated)

<!-- CURATION:frontmatter_schema id="frontmatter-requirements" -->
