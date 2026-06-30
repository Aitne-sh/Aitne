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
  them from DMs with `@<workspace>`, create and configure additional
  workspaces through the daemon API, and keep their file trees isolated
  on disk.
section: guides
tags:
  - guides
  - wiki
  - workspaces
  - knowledge
status: stable
ask_examples:
  - How do I run multiple wikis?
  - How do I target a specific wiki from a DM?
  - What does `@research` do before a wiki command?
locale: en-US
created: 2026-05-12
updated: 2026-05-28
keywords:
  - multi-workspace
  - wiki workspace
  - default workspace
  - "@workspace token"
related:
  - features/wiki/overview
  - features/wiki/workspaces
  - features/wiki/commands
  - guides/build-your-wiki
  - guides/use-an-existing-obsidian-vault
ui_anchors:
  - /settings/wiki
api_endpoints:
  - /api/wiki/workspaces
  - /api/wiki/workspaces/probe
  - /api/wiki/workspaces/:workspace
  - /api/wiki/workspaces/:workspace/archive
process_keys:
  - wiki.ingest_url
  - wiki.compile
  - wiki.ask
  - wiki.lint
  - wiki.trace
  - wiki.connect
---

# Multiple Wikis for Multiple Domains

Aitne can run more than one wiki workspace inside the same daemon. If
you keep distinct knowledge bases — say, a research vault, a parenting
journal, and an ops runbook — each can be its own wiki workspace. The
DM agent routes commands per workspace; the file trees never overlap.

> **Where this lives today.** The multi-workspace machinery is real at
> the daemon, API, and DM layers: you address any workspace from a DM
> with an `@<workspace>` token, and each row carries its own per-
> workspace settings. The dashboard's `/settings/wiki` page, however,
> currently manages only the **one active workspace** — it has no
> workspace picker and no "Add Workspace" button. Additional
> workspaces are created and archived through the daemon API
> (`POST /api/wiki/workspaces`), described below.

## Why you might want this

- **Topic isolation.** A query against your research wiki should not
  pull from your parenting journal. Separate workspaces give you
  separate `_index.md` and `20_wiki/` trees so the agent never has to
  filter across domains.
- **Different audiences.** A workspace synced via Obsidian to a shared
  iCloud folder for a team is governed differently from the daemon's
  internal workspace under its data directory. Per-workspace settings
  handle the asymmetry.
- **Different cadences.** A "current project" wiki gets multiple
  ingests per day; a long-term commonplace book may compile weekly.
  Per-workspace dispatch / cost / approval thresholds let you tune
  each.

## Creating a second workspace

The first workspace — the one named `default` — can be **internal**
(managed by the daemon under its own data directory at
`<contextDir>/knowledge/wiki/`) or **external** (an existing folder you
own). You pick that during initial setup on `/settings/wiki`.

Every *additional* workspace must be **external** — it points at a
folder on disk (an Obsidian vault, an iCloud-synced directory, a git
working copy). Only `default` is internal. Create a second workspace by
POSTing to the daemon API:

    curl -X POST http://localhost:8321/api/wiki/workspaces \
      -H 'content-type: application/json' \
      -d '{"kind":"external","name":"research","rootPath":"/Users/you/vaults/research"}'

- **`name`** — unique, 1–64 chars matching `[A-Za-z0-9][A-Za-z0-9._-]*`
  (letters, digits, `.`, `_`, `-`). This is what you address from DMs.
- **`rootPath`** — required for external workspaces. The daemon
  validates it before creating the row: it refuses to nest a wiki
  inside your primary vault, the data directory, or another active wiki
  (see [Path collision rules](#path-collision-rules-recap)). A failed
  validation returns a `4xx` with the collision reason — fix the path
  and retry.
- **`language`** (optional) — defaults to the daemon's wiki language.

Use `POST /api/wiki/workspaces/probe` with `{ "rootPath": "…" }` first
if you want the read-only collision diagnostics before committing the
row. On success the vault skeleton (`00_inbox/`, `10_raw/`, `20_wiki/`,
`30_outputs/`, `90_meta/`) is seeded into the folder and the workspace
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

Each workspace row carries its own settings:

- language (`en`, `ja`, …)
- dispatch mode (parallel / serial) and concurrency cap
- write strategy (`fs` / `cli` / `auto`) — external mode only
- full-compile approval threshold (USD)
- git pre-compile auto-commit toggle (external git vaults only)
- bridge feature gate + measurement mode + min confidence
- DM-agent bridge write toggle

The dashboard's `/settings/wiki` page edits these for the single active
workspace it surfaces. For any other workspace, PATCH the row directly:

    curl -X PATCH http://localhost:8321/api/wiki/workspaces/research \
      -H 'content-type: application/json' \
      -d '{"dispatchMode":"serial","fullCompileApprovalThresholdUsd":2.0}'

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

There is no per-workspace model binding today. If you want a research
vault on Opus 4.8 and a parenting journal on Haiku 4.5 at the same
time, you cannot — the `wiki.ask` row resolves to one backend/model for
every workspace. The pragmatic shape is:

- Bind `wiki.ask` to its medium-tier default (Sonnet 5), a sensible
  cross-workspace balance of cost and quality.
- Keep cost differences per workspace through each workspace's own
  full-compile approval threshold (see above).

Per-workspace model bindings are a possible future enhancement; the
present shape keeps `/settings/models` legible without a workspace
dimension.

## Archiving a workspace

`POST /api/wiki/workspaces/<name>/archive` flips a workspace's `active`
column to `0`. (The dashboard exposes a Stop/Remove control for the one
active workspace it surfaces; other workspaces are archived via the API
call.) Archived workspaces:

- disappear from `!wiki` listings,
- reject daemon API requests with `wiki_not_enabled`,
- drop out of `/search` and `/index`,
- keep their files on disk (you can re-activate later with no data
  loss),
- have their `fts_wiki` rows cleared eagerly so a same-id re-enable
  re-indexes from disk.

`DELETE /api/wiki/workspaces/<name>` removes the row entirely
(filesystem contents are preserved — the daemon never deletes vault
content). Use this when you are sure you will not re-enable.

## Path collision rules (recap)

Two active wiki workspaces cannot point at overlapping paths. Neither
can overlap:

- `primaryVaultPath` — your reactive-memory vault (`knowledge/`,
  `state/today.md`, etc.).
- `externalObsidianVaultPath` — your owner-facing Obsidian vault.
- `$PA_DATA_DIR` — the daemon's data home.

The pre-create validation (`POST /api/wiki/workspaces` and the
`/probe` endpoint) enforces this, and PATCH cannot widen past it. If
you want to migrate a workspace to a new disk location, archive the old
row, create a fresh row pointing at the new path, then manually copy
the vault contents.

## See also

- **features/wiki/overview** — what the wiki feature is and the four
  vault layers.
- **features/wiki/workspaces** — workspace lifecycle, internal vs
  external, and per-workspace settings in depth.
- **features/wiki/commands** — full bang-command reference, including
  the `@<workspace>` token.
- **guides/use-an-existing-obsidian-vault** — pointing a workspace at a
  folder you already own.
