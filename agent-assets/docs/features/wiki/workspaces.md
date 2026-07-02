---
schema_version: 1
slug: features/wiki/workspaces
title: Wiki Workspaces, Vaults, and Write Strategy
id: wiki-workspaces
aliases:
  - wiki workspace
  - wiki workspaces
  - internal wiki
  - external wiki
  - multi-workspace wiki
  - obsidian vault wiki
  - wiki write strategy
  - wiki language
category: features
summary: |
  How wiki workspaces are organised — the difference between internal
  and external mode, how multi-workspace addressing works (`@<name>`),
  how Aitne picks between direct filesystem writes and the Obsidian CLI
  on external vaults, and what each `/settings/wiki` toggle does to the
  underlying `wiki_workspaces` row.
section: wiki
tags:
  - wiki
  - workspaces
  - config
status: stable
ask_examples:
  - What is a wiki workspace?
  - What is the difference between internal and external wiki?
  - How do I add a second wiki workspace?
  - How do I switch between wikis in a DM?
  - Why is the wiki writing through the Obsidian CLI instead of directly?
  - What is the wiki write strategy?
  - Can the wiki language be different from my primary language?
  - Can two wikis live in nested folders?
locale: en-US
created: 2026-05-21
updated: 2026-07-01
keywords:
  - wiki workspace
  - workspace
  - internal mode
  - external mode
  - multi-workspace
  - @workspace
  - write strategy
  - fs strategy
  - cli strategy
  - auto strategy
  - obsidian-cli
  - iCloud sandbox
  - dispatch mode
  - parallel
  - serial
  - concurrency_cap
  - language
  - dm_agent_write_enabled
  - archive workspace
related:
  - features/wiki/overview
  - features/wiki/commands
  - features/wiki/dashboard
  - guides/use-an-existing-obsidian-vault
  - guides/multiple-wikis-for-multiple-domains
  - troubleshooting/wiki-write-failed
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
config_keys:
  - primaryVaultPath
  - externalObsidianVaultPath
---

# Wiki Workspaces, Vaults, and Write Strategy

A **wiki workspace** is one row in the `wiki_workspaces` table plus
the directory tree it points at. Aitne starts with no active
workspace. The first run of the Enable flow creates one named
`default`. You can run as many side-by-side wikis as you have
distinct knowledge domains — one per subject is a common setup.

## Internal vs external mode

| | Internal (recommended) | External |
|---|---|---|
| Root path | `$PA_DATA_DIR/context/knowledge/wiki/<name>` (daemon-owned, inside the context vault) | Any path you pick (typically an existing Obsidian vault) |
| Writes | Atomic local-fs writes | Atomic local-fs writes when permitted; Obsidian-CLI fallback for sandboxed paths |
| Backup surface | On-disk `.snapshots/<timestamp>/` tree under the workspace root | git auto-commit (when the vault is git-tracked) + sibling backup mirror under `90_meta/health/pre-migrate-<date>/` |
| iCloud-friendly | Yes (lives in `~/.personal-agent`) | Yes via the Obsidian CLI fallback (requires the Obsidian app running) |
| Best for | First-time users, isolated wiki, no Obsidian dependency | Power users with an existing Obsidian vault they want the agent to extend |

Path-collision rules apply to both modes:
- The workspace root must not overlap `PA_DATA_DIR`.
- It must not overlap your primary Obsidian vault (`primaryVaultPath`).
- It must not overlap the external Obsidian vault (`externalObsidianVaultPath`).
- Two wiki workspaces may not nest — neither root can be inside the other.

The dashboard probe (`POST /api/wiki/workspaces/probe`) runs these
checks live before the workspace row is written, and shows a
plain-language error if any rule is broken.

## The layered layout

Every workspace, internal or external, lays out the same five
top-level subdirectories plus a workspace-root `log.md`:

| Layer | Owner | Purpose |
|---|---|---|
| `00_inbox/` | Human-only | Drop-zone for things you want the agent to read but not write to. The agent has read access. |
| `10_raw/` | Wiki agent (append-only) | Source-faithful raw notes per URL ingested. |
| `20_wiki/` | Wiki agent | Synthesised wiki articles plus `_index.md`. |
| `30_outputs/` | Wiki agent | Answer / report artifacts from `!ask`, `!trace`, `!connect`. |
| `90_meta/` | Wiki agent | Taxonomy (`taxonomy.md`), schemas, health reports (`90_meta/health/<date>.md`), migration records (`90_meta/health/pre-migrate-<date>/`). |
| `log.md` | Wiki agent (append-only) | One line per write. Drives the dashboard timeline. |

The DM agent can read the wiki search and index routes, but only the
wiki process keys (`wiki.ingest_url`, `wiki.compile`, `wiki.ask`,
`wiki.lint`, `wiki.trace`, `wiki.connect`) may write into these
layers. Every write funnels through one route,
`POST /api/wiki/:workspace/files/:path`, which checks which layer the
path lands in and always rejects writes to `00_inbox/`.

## Multi-workspace addressing

Every wiki bang command takes an optional `@<name>` token right
after the bang to aim at a specific workspace. Aitne reads this token
before the command parses the rest of the line, so multi-word topics
and comma-separated arguments still work as usual:

```
!compile @research full
!ask @parenting what did the pediatrician recommend?
!connect @research diffusion models, score matching
```

Leave the token off and the command targets the **default**
workspace — in practice the oldest active workspace (lowest id). That
is the one named `default` on a fresh install, or the next-oldest
active workspace if `default` has been archived.

A workspace name after `@` must start with a letter or digit, and the
rest may contain only letters, digits, `.`, `_`, or `-` (max 64
chars). An invalid token gets a usage error rather than a silent
fall-back to the default.

See [guides/multiple-wikis-for-multiple-domains](../../guides/multiple-wikis-for-multiple-domains.md)
for a walkthrough.

## Write strategy (`fs` / `cli` / `auto`)

`wiki_workspaces.write_strategy` controls how the daemon persists a
write. Three values:

- **`fs`** — atomic local-fs writes via `writeFileAtomically()`.
  Internal-mode workspaces always use `fs`; the toggle is fixed on
  the row but the column is read-only for internal workspaces.
- **`cli`** — writes go through the official Obsidian CLI (the
  Catalyst-only CLI shipped since 2026-02; requires the Obsidian app
  running). Used for external vaults that live in sandboxed
  locations (typically iCloud-synced vaults) where direct fs writes
  fail with `EPERM` / `EACCES` / `EROFS` / `EBUSY`.
- **`auto`** — tries `fs` first, falls back to `cli` on those
  sandbox error codes, and saves the value it settled on back to the
  row so later writes skip the check.

Internal workspaces are pinned to `fs`. External workspaces start in
`auto` and tune themselves. You can override the resolved value from
`/settings/wiki` if you need to force one path or the other (for
example, to test the CLI path on a non-sandboxed vault).

The resolved strategy shows up in the workspace API response and on
the `/settings/wiki` row, so you can always see which path (`fs` or
`cli`) `auto` settled on. The full design is in
WIKI_BUILDER_DESIGN.md §P2.B / §8.

## Dispatch mode (`parallel` / `serial`)

`!ingest` honours the per-workspace **dispatch mode** in
`/settings/wiki`:

- **Parallel** (default): all URLs run at once, up to the per-URL
  concurrency cap (`wiki_workspaces.concurrency_cap`, default `3`,
  valid range 1–10). Fastest, with a small risk of tripping rate
  limits at the URL's host.
- **Serial**: URLs run in the order you submitted them; each agent
  session starts only after the previous one finishes. Slower, but
  the budget and request rate stay predictable.

The acknowledgement DM tells you which mode ran
(`in parallel` / `serially`).

## Language

`wiki_workspaces.language` is the workspace's content language. It
defaults to `en` and is separate from `runtimeSettings.primaryLanguage`
— see WIKI_BUILDER_DESIGN.md §14 Q2 for the reasoning. Pick any
language tag from the picker in `/settings/wiki`; Aitne passes that
value to the wiki skills as the target language for compiled
articles, ask answers, and trace / connect outputs.

The wiki language does **not** cascade from your primary language at
seed time. A user who runs the dashboard in Japanese can keep their
wiki in English, and vice versa.

## Archive vs delete

- **Archive** — sets `active=0` on the row but keeps the on-disk
  data and the row's metadata. Bang commands cannot target an
  archived workspace; the dashboard hides it from the active list and
  tucks it into an "Archived" collapsible. Re-enable the workspace to
  unarchive it.
- **Delete** — drops the row. The on-disk data is **not** removed for
  external workspaces (the daemon never deletes your vault). For
  internal workspaces, the disk tree is also left in place under
  `$PA_DATA_DIR/context/knowledge/wiki/<name>` — to recover, create a
  workspace again with the same name.

## Fields and defaults reference

Quick map between the dashboard knobs and the `wiki_workspaces` row:

| Setting | Column | Default |
|---|---|---|
| Workspace name | `name` | `default` |
| Kind | `kind` | `internal` |
| Root path | `root_path` | `$PA_DATA_DIR/context/knowledge/wiki/<name>` (internal) |
| Language | `language` | `en` |
| Dispatch mode | `dispatch_mode` | `parallel` |
| Concurrency cap | `concurrency_cap` | `3` |
| Write strategy | `write_strategy` | `fs` (internal) / `auto` (external) |
| Pre-compile git auto-commit | `git_pre_compile_enabled` | `1` |
| Full-compile approval threshold | `full_compile_approval_threshold_usd` | `2.00` |
| DM-agent writes allowed | `dm_agent_write_enabled` | `0` |
| Bridge feature | `bridge_enabled` | `0` |
| Bridge measurement-only | `bridge_measurement_only` | `1` |
| Bridge min confidence | `bridge_min_confidence` | `0.70` |
| Active | `active` | `1` |

`dm_agent_write_enabled=0` is the safe default — the DM agent can
only call the read-side wiki routes. Writes happen inside dedicated
`wiki.*` sessions that bang commands spawn.
