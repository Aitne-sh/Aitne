---
schema_version: 1
slug: features/wiki/overview
title: Wiki Overview
id: wiki-overview
aliases:
  - wiki
  - personal wiki
  - knowledge vault
  - wiki builder
category: features
summary: |
  Aitne's opt-in personal wiki — a separate, LLM-maintained knowledge
  vault used for durable research, references, and personal knowledge
  that should compound over time. Distinct from Aitne's reactive memory.
section: wiki
tags:
  - wiki
  - knowledge
status: stable
ask_examples:
  - What is the wiki?
  - How is the wiki different from memory?
  - Where does the wiki live on disk?
  - Can I point the wiki at my Obsidian vault?
locale: en-US
created: 2026-05-12
updated: 2026-07-01
keywords:
  - wiki
  - wiki workspace
  - 00_inbox
  - 10_raw
  - 20_wiki
  - 30_outputs
  - 90_meta
  - wiki layers
  - external vault
  - internal vault
  - opt-in
  - wiki process keys
  - wiki dispatcher
  - dashboard wiki page
related:
  - features/wiki/commands
  - features/wiki/dashboard
  - features/wiki/workspaces
  - features/wiki/search
  - features/wiki/cost-and-approval
  - concepts/memory-model
  - guides/build-your-wiki
  - guides/use-an-existing-obsidian-vault
  - guides/budget-and-cost-for-wiki
  - guides/multiple-wikis-for-multiple-domains
  - guides/maintain-wiki-health
  - guides/explore-with-trace-and-connect
  - troubleshooting/wiki-write-failed
  - troubleshooting/wiki-ingest-full-blocked
ui_anchors:
  - /wiki
  - /wiki/timeline
  - /settings/wiki
api_endpoints:
  - /api/wiki/workspaces
  - /api/wiki/:workspace/index
  - /api/wiki/:workspace/search
  - /api/wiki/:workspace/estimate
process_keys:
  - wiki.ingest_url
  - wiki.compile
  - wiki.ask
  - wiki.lint
  - wiki.trace
  - wiki.connect
---

# Wiki Overview

## In One Sentence

The wiki is an opt-in personal knowledge vault — separate from
Aitne's reactive memory — that the agent grows from URLs you send it
and questions you ask it.

## What It Does

The three commands you reach for daily:

- **URL ingest**: send `!ingest <url>` from a paired DM channel; the wiki
  agent fetches the source, summarizes it, and stores a raw note.
- **Compile**: `!compile` (incremental) and `!compile full` (full
  rebuild) turn raw notes into synthesized wiki articles with
  cross-links and an `_index.md` catalog.
- **Ask**: `!ask <question>` searches the wiki and writes a cited
  answer under `30_outputs/`.

Three more for upkeep and exploration: `!lint` (health report),
`!trace` (reconstruct an idea's evolution), and `!connect` (bridge two
domains). `!wiki` prints workspace status. See the
[commands reference](commands.md) for all of them.

The wiki uses its own process keys — `wiki.ingest_url`, `wiki.compile`,
`wiki.ask`, `wiki.lint`, `wiki.trace`, `wiki.connect` — each with
independent backend / model / budget settings, so the wiki never
competes for budget with daily reactive memory.

## Internal vs External

Aitne offers two modes:

- **Internal** (recommended starting point) — the daemon owns the
  vault at `$PA_DATA_DIR/context/knowledge/wiki`. No sandbox
  permission issues, snapshots are managed for you, and it stays clear
  of iCloud sync conflicts.
- **External** — you point the wiki at an existing Obsidian vault on
  disk. The daemon writes directly when the filesystem allows, and
  falls back to the official Obsidian CLI when the vault sits in a
  sandboxed location (iCloud) and the Obsidian app is running.

Path-collision rules: the external root must not overlap `dataDir`,
your primary vault, or the external Obsidian vault path. Two wiki
workspaces may not nest.

## Layers

- `00_inbox/` — human-only capture (the agent has read access but
  cannot write here).
- `10_raw/` — source-faithful raw notes (append-only).
- `20_wiki/` — synthesized wiki articles + `_index.md` catalog.
- `30_outputs/` — answer / report artifacts written by `!ask`.
- `90_meta/` — taxonomy, schemas, lint reports, and the
  `import-<date>.md` migration record.
- `log.md` — append-only operational log.

The DM agent can read wiki search and index routes but only wiki
process keys can write wiki layers.

## Cost Safety

`!compile full` rebuilds the entire wiki from raw notes and is the
most expensive command, so Aitne guards it: the dashboard shows a cost
estimate before you run it, a large run needs your approval (the
per-workspace threshold defaults to $2.00), and a git-tracked external
vault gets a snapshot commit first so you can roll back a surprising
run. See [Cost estimation and approval](cost-and-approval.md) for the
exact estimate math, the approval flow, and the pre-compile snapshot.

## Where it lives in the dashboard

The wiki has two distinct surfaces in the dashboard. The split mirrors
how Aitne organizes the rest of the app — configuration lives under
**Setup → Settings**, day-to-day content browsing lives under **My
Life** next to Knowledge / Reading / Git.

| Page | Section | Use it for |
|---|---|---|
| `/wiki` | My Life | Workspace summary, the compiled `_index.md` catalog, and the latest activity log. The page you open most often. |
| `/wiki/timeline` | My Life | Full chronological activity log plus the latest `!lint` health report. Linked from `/wiki` and from settings. |
| `/settings/wiki` | Setup → Settings | Enable / archive a workspace, switch between internal and external mode, pick an external vault path, language, dispatch mode, write strategy, git auto-commit, approval threshold, per-command model selectors. |

The **My Life → Wiki** entry is always visible in the sidebar, even
before you enable a workspace, so the feature is easy to find. The
`/wiki` page itself renders an **Enable Wiki** call-to-action when no
workspace is active — clicking it jumps you to `/settings/wiki` where
the same internal / external choice surfaces.

The wiki is off by default on a fresh install; nothing is written to
disk until you opt in.

### Settings page states

`/settings/wiki` is two-state:

- **Disabled** (no active workspace) — a single "Enable Internal
  Workspace" CTA plus an external-path picker. The picker opens your
  OS-native folder dialog (Finder on macOS, File Explorer on Windows,
  the system folder dialog on Linux) and shows an inline validation
  banner once you pick a path — see [guides/use-an-existing-obsidian-vault](../../guides/use-an-existing-obsidian-vault.md).
- **Enabled** — full configuration: language, dispatch mode, write
  strategy, git auto-commit toggle, approval threshold, per-command
  model selectors, plus archive / delete. A "Browse wiki" link at the
  top jumps you back to `/wiki`.

## Where to go next

This page is a high-level tour. For depth on a specific surface:

- **[Commands reference](commands.md)** — every wiki bang command
  (`!ingest`, `!compile`, `!ask`, `!lint`, `!trace`, `!connect`,
  `!wiki`), the `@<workspace>` addressing token, dispatch modes, and
  the disabled-state behavior.
- **[Dashboard surfaces](dashboard.md)** — what `/wiki`,
  `/wiki/timeline`, and `/settings/wiki` actually render, where each
  card reads from on disk, and how the contextual help button maps
  to this doc set.
- **[Workspaces, vaults, write strategy](workspaces.md)** — internal
  vs external, multi-workspace `@<name>` addressing, fs/cli/auto
  write strategy, dispatch modes, language, and archive vs delete.
- **[Search and index](search.md)** — how `!ask` / `!trace` /
  `!connect` find content via `_index.md` and the FTS5 `fts_wiki`
  virtual table, plus the rebuild path.
- **[Cost estimation and approval](cost-and-approval.md)** — the
  bracketed 0.5×/2× cost estimator, the `!compile full` approval
  threshold, the pre-compile git snapshot, and the `--preview`
  dry-run.
