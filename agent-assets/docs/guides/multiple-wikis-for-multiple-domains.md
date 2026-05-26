---
schema_version: 1
slug: guides/multiple-wikis-for-multiple-domains
title: Multiple Wikis for Multiple Domains
id: multiple-wikis-for-multiple-domains
aliases:
  - multi-workspace wiki
  - multiple workspaces
  - domain wikis
category: guides
summary: |
  Run more than one wiki workspace inside the same daemon. Address
  them from DMs with `@<workspace>`, manage them independently from
  /settings/wiki, and keep their file trees isolated on disk.
section: multiple-wikis-for-multiple-domains
tags:
  - guide
  - wiki
  - multi-workspace
status: stable
ask_examples:
  - How do I run multiple wikis?
  - How do I target a specific wiki from a DM?
  - What does `@research` do before a wiki command?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - multi-workspace
  - wiki workspace
  - default workspace
  - @workspace token
related:
  - features/wiki/overview
  - features/wiki/commands
  - guides/build-your-wiki
  - guides/use-an-existing-obsidian-vault
---

# Multiple Wikis for Multiple Domains

Phase 5 lifted Aitne's single-workspace ceiling. If you keep distinct
knowledge bases — say, a research vault, a parenting journal, and an
ops runbook — you can run each as its own wiki workspace inside the
same daemon. The DM agent routes commands per workspace; the file
trees never overlap.

## Why you might want this

- **Topic isolation.** A query against your research wiki should not
  pull from your parenting journal. Separate workspaces give you
  separate `_index.md` and `20_wiki/` trees so the agent never has to
  filter across domains.
- **Different audiences.** A workspace synced via Obsidian to a shared
  iCloud folder for a team is governed differently from a private
  workspace in `$PA_DATA_DIR`. Per-workspace settings handle the
  asymmetry.
- **Different cadences.** A "current project" wiki gets multiple
  ingests per day; a long-term commonplace book may compile weekly.
  Per-workspace dispatch / cost / approval thresholds let you tune
  each.

## Creating a second workspace

1. Open `/settings/wiki`. You will see your current (default)
   workspace.
2. Scroll to **Add Workspace** (Phase 5 surface). Choose either:
   - **Internal**, which lives under `$PA_DATA_DIR/wiki-<name>/`. Best
     for private notes you never sync to another device.
   - **External**, which points at an existing folder on disk (your
     Obsidian vault, an iCloud-synced directory, a git working copy).
3. Pick a unique `name` (lowercase letters, digits, `.`, `_`, `-`). The
   name is what you address from DMs.
4. The wizard probes the candidate path against §2.1.1 collision rules
   — it refuses to nest a wiki inside your primary vault, the data
   directory, or another active wiki. Iterate until the probe is green.
5. Click **Create**. The vault skeleton (`00_inbox/`, `10_raw/`,
   `20_wiki/`, `30_outputs/`, `90_meta/`) is seeded and the workspace
   joins the active set.

## Addressing a workspace from DMs

Every wiki bang command accepts an optional `@<workspace>` token
immediately after the bang:

    !ingest @research https://arxiv.org/abs/2401.02954
    !compile @research full
    !ask @research what did I conclude about retrieval-augmented LMs?
    !lint @parenting
    !trace @ops "incident 2026-05-02"
    !connect @research "diffusion models" "score matching"

Omit `@<workspace>` and the command targets the default workspace
(the one named `default`, set during initial setup).

The `@<token>` syntax is parsed before the command's own argument
parser sees the rest, so you can keep using multi-word topics and
comma-separated arguments verbatim.

## What the agent sees per workspace

Each session is materialised against a single workspace's tree. The
`wiki-vault-rules` skill loaded for the session names that workspace's
language, dispatch mode, layer invariants, and frontmatter
conventions. Layer authorisation in the daemon API is workspace-scoped
— a `wiki.ask` session against `@research` cannot reach into
`@parenting`'s `10_raw/` even if the agent attempts it.

## `!wiki` status with multiple workspaces

`!wiki` (no token) lists every active workspace in a compact form:

    3 active wiki workspaces:
    - `default` (default) — 12r/8w/3o (internal)
    - `research` — 84r/41w/12o (external)
    - `parenting` — 7r/2w/0o (external)

    Target a non-default workspace with `@<name>` (e.g. `!ask @research <question>`).

`r/w/o` are raw / wiki / output counts. The `(default)` marker tells
you which workspace `!ask` (with no `@`) will route to.

## Configuring each workspace independently

`/settings/wiki` shows a workspace picker at the top once you have
more than one. Each workspace's panel carries its own:

- language (`en`, `ja`, …)
- dispatch mode (parallel / serial) and concurrency cap
- write strategy (`fs` / `cli` / `auto`) — external mode only
- full-compile approval threshold (USD)
- git pre-compile auto-commit toggle (external git vaults only)
- bridge feature gate + measurement mode + min confidence (Phase 5)
- DM-agent bridge write toggle

`POST /api/backends/apply-defaults` re-seeds the per-process backend /
model / budget rows but leaves the per-workspace columns alone — those
are operator preferences, not install defaults.

## Per-workspace `/settings/models` rows

`/settings/models` lists the wiki process keys
(`wiki.ingest_url`, `wiki.compile`, `wiki.ask`, `wiki.lint`,
`wiki.trace`, `wiki.connect`) once each. The backend / model / budget
bound to each key applies across all workspaces — they share the
binding because the daemon resolves the row by process key, not by
workspace.

If you need a research vault on Opus 4.7 and a parenting journal on
Haiku 4.5 at the same time, the supported path today is:

- Bind `wiki.ask` to medium-tier Sonnet (a sensible cross-workspace
  default).
- Use the workspace-aware `!ask @research` for the research vault and
  rely on per-workspace token budgets via the cost ceiling.

A future enhancement is per-workspace model bindings; the present
shape was chosen to keep `/settings/models` legible without a
workspace dimension.

## Archiving a workspace

The dashboard's **Archive** button on a workspace card flips its
`active` column to `0`. Archived workspaces:

- disappear from `!wiki` listings,
- reject all daemon API requests with `wiki_not_enabled`,
- drop out of `/search` and `/index`,
- keep their files on disk (you can re-activate later with no data
  loss),
- have their `fts_wiki` rows cleared eagerly so a same-id re-enable
  re-indexes from disk.

`DELETE /wiki/workspaces/:name` removes the row entirely (filesystem
contents are preserved — the daemon never deletes vault content). Use
this when you are sure you will not re-enable.

## Path collision rules (recap)

Two active wiki workspaces cannot point at overlapping paths. Neither
can overlap:

- `primaryVaultPath` — your reactive-memory vault (`knowledge/`,
  `state/today.md`, etc.).
- `externalObsidianVaultPath` — your owner-facing Obsidian vault.
- `$PA_DATA_DIR` — the daemon's data home.

The wizard's pre-create probe enforces this; PATCH cannot widen past
it. If you want to migrate a workspace to a new disk location, archive
the old row, create a fresh row pointing at the new path, then
manually copy the vault contents.

## See also

- `docs/design/23-wiki-builder.md` — Phase summary table for the
  overall wiki feature.
- `docs/design/appendices/wiki-external-vault.md` — write strategy,
  iCloud handling, snapshot exclusion.
- `docs/design/appendices/wiki-bridge-mechanism.md` — Phase 5 bridge
  capture from DMs into a workspace's raw layer.
- `docs/user/features/wiki/commands.md` — full bang command reference.
