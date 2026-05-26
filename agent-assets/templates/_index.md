---
type: index
owner: shared
updated: 2026-05-25
template_version: 2
---
# Aitne Vault

This directory is shared by the agent and me. Six top-level folders sit
under this root; each carries a single authority/lifecycle contract so I
(and the agent) can always tell which kind of file lives where. The
agent writes most of it; I can edit any file and my edits are preserved
(see `policies/management.md` for conflict handling).

## Where things live

- **About me** → `identity/` (profile, people, work, expertise, personal, goals)
- **Today / Yesterday** → `state/today.md`, `state/yesterday.md`
- **Roadmap & projects** → `plans/roadmap.md`, `plans/projects/<slug>.md`
  (open `plans/projects/_active.base` in Obsidian for the active list)
- **Inbox dumps** → `state/inbox/` (paste anything here; I'll triage on
  the next morning routine)
- **Agent scratch** → `state/scratch/` (48h-TTL working area; not
  durable)
- **Activity views** → `state/activity/` (90-day reconciler outputs)
- **Profile-question queue** → `state/profile-questions.md`
- **Daily / Weekly / Monthly journals** → `journal/daily/`,
  `journal/weekly/`, `journal/monthly/` (date-named, append-only)
- **Per-repo journals** → `journal/repos/<slug>/<date>.md`
- **Agent self-reflection** → `journal/agent.md` (decision log,
  append-only, never DM'd)
- **Wiki workspaces** → `knowledge/wiki/<workspace>/` (internal vaults
  live here; external Obsidian vaults stay external)
- **Per-repo overviews** → `knowledge/repos/<slug>/overview.md`
- **Dossiers** → `knowledge/dossiers/` (accumulated agent research)
- **Management-registry entities** → `knowledge/entities/<domain>/<type>/<slug>.md`
- **Rules & policies** → `policies/` (`management.md`, `mcp.md`,
  `redaction.md`, `journal-format.md`, `journal-export.md`,
  `integrations.md`)
- **Routines** → `policies/routines/` (per-cadence rulebooks)
- **User skills** → `policies/skills/<slug>/SKILL.md`
- **Policy captures** → `policies/management-captures/`

## How the agent reads/writes this

All writes go through the context API (locked + snapshotted). Read:
direct. `Edit`/`Write` tools are not available to the agent — the API
is the only chokepoint.

The block below is maintained by the daemon reconciler. Edits inside
the `<!-- reconciler-section -->` markers are overwritten on the next
run. Anything outside the markers is yours and is preserved.

<!-- reconciler-section -->
<!-- /reconciler-section -->
