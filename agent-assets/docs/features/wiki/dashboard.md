---
schema_version: 1
slug: features/wiki/dashboard
title: Wiki Dashboard Surfaces
id: wiki-dashboard
aliases:
  - wiki dashboard
  - wiki ui
  - wiki page
  - wiki timeline page
  - wiki settings page
  - /wiki
  - /wiki/timeline
  - /settings/wiki
category: features
summary: |
  Reference for the three dashboard surfaces the wiki feature renders:
  `/wiki` (workspace summary + index + recent activity), `/wiki/timeline`
  (full chronological log + latest health report), and `/settings/wiki`
  (configuration). Explains what each card shows, where the data comes
  from on disk, and what to do when a card is empty.
section: wiki
tags:
  - wiki
  - dashboard
  - reference
  - core
status: stable
ask_examples:
  - What does the /wiki page show?
  - Where do I find the wiki health report?
  - Why is the Recent activity card empty?
  - How do I see every !ingest run for a workspace?
  - Where is the wiki configuration page?
  - What is _index.md and where does the wiki page render it?
  - How is /wiki different from /wiki/timeline?
  - What does the Enable Wiki button do?
locale: en-US
created: 2026-05-21
updated: 2026-05-28
keywords:
  - /wiki
  - /wiki/timeline
  - /settings/wiki
  - wiki dashboard
  - workspace summary card
  - _index.md
  - log.md
  - health report
  - 90_meta/health
  - recent activity
  - timeline filter
  - Enable Wiki CTA
  - vault path picker
related:
  - features/wiki/overview
  - features/wiki/commands
  - features/wiki/workspaces
  - features/wiki/cost-and-approval
  - guides/build-your-wiki
  - guides/maintain-wiki-health
  - guides/use-an-existing-obsidian-vault
ui_anchors:
  - /wiki
  - /wiki/timeline
  - /settings/wiki
api_endpoints:
  - /api/wiki/workspaces
  - /api/wiki/:workspace/index
  - /api/wiki/:workspace/files/log.md
  - /api/wiki/:workspace/health
  - /api/wiki/:workspace/estimate
  - /api/wiki/:workspace/compile/preview
process_keys:
  - wiki.ask
  - wiki.compile
  - wiki.ingest_url
  - wiki.lint
  - wiki.trace
  - wiki.connect
---

# Wiki Dashboard Surfaces

The wiki has three distinct pages in the dashboard. The split mirrors
Aitne's broader IA: content browsing lives under **My Life**,
configuration lives under **Setup → Settings**. The pages share a
single read path through the daemon's `/api/wiki/*` routes — every
request carries an `x-process-key: wiki.ask` header so the safety
layer can attribute reads correctly.

## `/wiki` — workspace home

The page you open most often. Three cards stacked top-down:

### 1. Workspace summary

A single card with the workspace name, root path, kind badge
(`Internal` / `External`), language badge, and a stats table:

| Stat | Source |
|---|---|
| Raw notes | Count of files under `10_raw/` |
| Wiki pages | Count of files under `20_wiki/` |
| Outputs | Count of files under `30_outputs/` |
| Last ingest | `wiki_workspaces.last_ingest_at` |
| Last compile | `wiki_workspaces.last_compile_at` |

Two action buttons at the bottom of the card: **Timeline & health**
(jumps to `/wiki/timeline`) and **Configuration** (jumps to
`/settings/wiki`).

### 2. Index

Renders the latest `20_wiki/_index.md`, the LLM-maintained catalogue
of wiki pages. The agent rewrites this file at the end of every
`!compile` run.

States:
- **Empty** — no `_index.md` yet; the CTA tells you to run `!compile`
  from a DM.
- **Loaded** — the file is rendered verbatim as a monospaced code
  block (the index uses wikilink syntax, so rendering as markdown
  would lose information).

### 3. Recent activity

The last 8 entries from `log.md`, the wiki's append-only operational
log. Each entry shows the wiki process key (`wiki.ingest_url`,
`wiki.compile`, `wiki.ask`, `wiki.lint`, `wiki.trace`, `wiki.connect`),
the operation (`write`, `delete`, …), the affected path, and the
timestamp. A **View full timeline** button at the top of the card
opens `/wiki/timeline`.

A freshly-enabled wiki has no `log.md` yet — the route returns 404
and the card shows the "No activity yet" hint instead of a scary
error toast.

### Disabled state

When no `active=1` workspace exists in `wiki_workspaces`, the page
shows an **Enable Wiki** CTA that jumps to `/settings/wiki`. The
sidebar entry is always visible (gated only on the workspace
catalogue being reachable), so this disabled state is reachable via
the sidebar, a deep link, or browser history.

## `/wiki/timeline` — full chronological history + health

Two surfaces stacked on one page:

### 1. Latest health report

Renders the newest `90_meta/health/<YYYY-MM-DD>.md` produced by
`!lint`. The card shows:

- A purple date badge and the source file path.
- A `## Summary` block (bulleted list).
- An `## Action items` list (the punch-list of orphan notes, broken
  wikilinks, schema drift, taxonomy candidates, and stale-note
  warnings).
- A collapsible **View full report** button that reveals the raw
  Markdown body of the report.

Empty state: "No health reports yet — send `!lint` from a DM to
generate the first one."

### 2. Activity timeline

A reverse-chronological view of `log.md` with a process-key filter.
The filter dropdown lists every distinct `wiki.*` key found in the
log plus an **All commands** default. Entries render the same way
they do in the `/wiki` recent-activity card — process-key badge,
operation, path, timestamp.

Both surfaces read live from the wiki API; the timeline page is a
pure rendering pass over files the wiki skills already produce — no
extra daemon-side schema backs them.

## `/settings/wiki` — configuration

The configuration surface. Two-state:

### Disabled (no active workspace)

A two-card chooser:

- **Internal** (recommended) — managed by Aitne in its data directory
  (default `~/.personal-agent/wiki`), schema seeded automatically.
  The **Enable internal wiki** button turns it on with nothing else
  to configure.
- **Existing Obsidian vault** (external) — point Aitne at a folder you
  already own via the path picker, then confirm with **Use this
  folder**.

The path picker opens your OS-native folder dialog (Finder on macOS,
File Explorer on Windows, the system folder dialog on Linux) and shows
an inline validation banner once you pick a path:

- Path-collision rules — the external root must not overlap
  `dataDir`, your primary Obsidian vault, or another wiki workspace.
- Existing-Obsidian-vault detection — when the picker finds an
  Obsidian vault at the target, the wiki layout is detected and
  migrated on demand so you can import the vault's content (see
  [guides/use-an-existing-obsidian-vault](../../guides/use-an-existing-obsidian-vault.md)
  and [features/wiki/workspaces](workspaces.md)).

### Enabled

The full configuration:

- **Workspace** — name, kind (internal / external), root path, language.
- **Dispatch mode** for `!ingest` (Parallel / Serial) and the
  concurrency cap.
- **Write strategy** (`fs` / `cli` / `auto`) — internal workspaces
  always use `fs`; external workspaces start in `auto` and probe on
  first write (see [features/wiki/workspaces](workspaces.md)).
- **Git auto-commit before `!compile full`** toggle (only meaningful
  on a git-tracked external vault).
- **Approval threshold (USD)** for `!compile full`.
- **Commands & models** — per-command selectors for the backend,
  model, turn limit, and per-run budget on each `wiki.*` process key
  (`wiki.ingest_url`, `wiki.compile`, `wiki.ask`, `wiki.lint`,
  `wiki.trace`, `wiki.connect`). All six default to the medium tier
  (Claude Sonnet 4.6) with a sensible `maxTurns` / `maxBudgetUsd`; you
  can override per key.
- **Archive / delete** — archive keeps the row but flips `active=0`;
  delete drops the row (data on disk is untouched on external mode).

The top of the enabled page carries a **Browse wiki** link that jumps
back to `/wiki`.

## Where each surface reads from

| Surface | API route | On-disk source |
|---|---|---|
| Workspace summary | `GET /api/wiki/workspaces` | `wiki_workspaces` table |
| Index card | `GET /api/wiki/:ws/index` | `20_wiki/_index.md` |
| Recent activity | `GET /api/wiki/:ws/files/log.md` | `log.md` |
| Health report | `GET /api/wiki/:ws/index` + `/files/...` | `90_meta/health/<date>.md` |
| Activity timeline | `GET /api/wiki/:ws/files/log.md` | `log.md` |
| Settings | `GET /api/wiki/workspaces`, `PATCH /api/wiki/workspaces/:ws` | `wiki_workspaces` table |

Every wiki API request is gated by the `x-process-key` header. The
dashboard uses `wiki.ask` as the closest read-only intent; the
auth layer accepts any `wiki.*` key for GETs (see
`authorizeWikiRequest` in `packages/daemon/src/api/routes/wiki.ts`).

## Contextual help

Every wiki page in the dashboard exposes a `?` Help button in the
top-right action strip. Clicking it opens the relevant wiki doc in a
slide-over for in-context reading (mirrors the global help pattern
used everywhere else in the dashboard). `/wiki/timeline` opens this
doc; `/wiki` opens [features/wiki/overview](overview.md) and
`/settings/wiki` opens [features/wiki/workspaces](workspaces.md).
