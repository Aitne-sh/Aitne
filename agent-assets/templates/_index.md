---
type: index
owner: shared
updated: 2026-04-22
template_version: 1
---
# Aitne Vault

This directory is shared by the agent and me. The agent writes most of it;
I can edit any file and my edits are preserved (see `rules/management.md`
for conflict handling).

## Where things live

- **About me** → `user/` (profile, people, work, expertise, personal, goals)
- **Today / Roadmap** → root-level `today.md` and `roadmap.md`
- **Yesterday snapshot** → yesterday.md appears after the first morning
  rotation and is replaced by the next one
- **Projects** → `projects/`; project notes use the projects/<slug>.md
  naming pattern. See `projects/_index.md` or open `projects/_active.base`
  in Obsidian
- **Daily archives** → `daily/` files named by date (synthesized journal)
- **Weekly / Monthly reviews** → `weekly/`, `monthly/`
- **Agent self-reflection** → `agent/journal.md` (internal; never pushed
  as a notification)
- **Rules & policies** → `rules/` (how the agent should behave — edited by
  either of us)
- **Routines** → `routines/` (per-cadence check-list rulebooks)
- **Dump bucket** → `inbox/` (paste anything here; I'll triage on next
  morning routine)

## How the agent reads/writes this

All writes go through the context API (locked + snapshotted). Read: direct.
`Edit`/`Write` tools are not available to the agent — the API is the only
chokepoint.

This file is human-readable navigation. The agent's canonical file catalog
is `context-index.md`, maintained from the filesystem.
