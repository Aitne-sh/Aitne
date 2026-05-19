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
  - core
status: stable
ask_examples:
  - What is the wiki?
  - How is the wiki different from memory?
  - Where does the wiki live on disk?
  - Can I point the wiki at my Obsidian vault?
locale: en-US
created: 2026-05-12
updated: 2026-05-17
keywords:
  - wiki
  - wiki workspace
  - 00_inbox
  - 10_raw
  - 20_wiki
  - 30_outputs
  - wiki layers
  - external vault
related:
  - features/wiki/commands
  - concepts/memory-model
  - guides/build-your-wiki
  - guides/use-an-existing-obsidian-vault
  - guides/budget-and-cost-for-wiki
  - troubleshooting/wiki-write-failed
  - troubleshooting/wiki-ingest-full-blocked
ui_anchors:
  - /wiki
  - /wiki/timeline
  - /settings/wiki
---

# Wiki Overview

## In One Sentence

The wiki is an opt-in personal knowledge vault — separate from
Aitne's reactive memory — that the agent grows from URLs you send it
and questions you ask it.

## What It Does

- **URL ingest**: send `!ingest <url>` from a paired DM channel; the wiki
  agent fetches the source, summarises it, and stores a raw note.
- **Compile**: `!compile` (incremental) and `!compile full` (full
  rebuild) turn raw notes into synthesised wiki articles with
  cross-links and an `_index.md` catalogue.
- **Ask**: `!ask <question>` searches the wiki and writes a cited
  answer under `30_outputs/`.

The wiki uses its own process keys (`wiki.ingest_url`, `wiki.compile`,
`wiki.ask`) with independent backend / model / budget settings, so it
never competes for budget with daily reactive memory.

## Internal vs External

Aitne offers two modes:

- **Internal** (recommended starting point) — the daemon owns the
  vault at `$PA_DATA_DIR/wiki`. No sandbox issues, daemon-managed
  snapshots, isolated from iCloud sync conflicts.
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
- `20_wiki/` — synthesised wiki articles + `_index.md` catalogue.
- `30_outputs/` — answer / report artifacts written by `!ask`.
- `90_meta/` — taxonomy, schemas, lint reports, and the
  `import-<date>.md` migration record.
- `log.md` — append-only operational log.

The DM agent can read wiki search and index routes but only wiki
process keys can write wiki layers.

## Cost Safety

`!compile full` rebuilds the entire wiki from raw notes and is the
most expensive command. The dashboard banner shows the bracketed
estimate ($0.5×–$2× the assumed input-token spend) before you run
it. If the pessimistic estimate exceeds the per-workspace threshold
(default $2.00), the command escalates to the dashboard `/approvals`
queue and requires your explicit confirmation before the compile
starts.

On a git-tracked external vault, Aitne also runs
`git add -A && git commit -m "aitne wiki: pre-compile snapshot <ts>"`
on a clean working tree before the compile so you can roll back if
the run produces a surprise. A dirty tree refuses the operation —
commit or stash first.

## Where it lives in the dashboard

The wiki has two distinct surfaces in the dashboard. The split mirrors
how Aitne organises the rest of the app — configuration lives under
**Setup → Settings**, day-to-day content browsing lives under **My
Life** next to Knowledge / Reading / Git.

| Page | Section | Use it for |
|---|---|---|
| `/wiki` | My Life | Workspace summary, the compiled `_index.md` catalogue, and the latest activity log. The page you open most often. |
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
