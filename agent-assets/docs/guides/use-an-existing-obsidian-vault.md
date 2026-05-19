---
schema_version: 1
slug: guides/use-an-existing-obsidian-vault
title: Use an Existing Obsidian Vault
id: use-an-existing-obsidian-vault
aliases:
  - external wiki
  - obsidian vault as wiki
  - external mode
category: guides
summary: |
  Point Aitne's wiki at an Obsidian vault you already maintain. The
  setup wizard probes the path, classifies the layout, and walks you
  through Adopt vs Migrate vs Split.
section: use-an-existing-obsidian-vault
tags:
  - guide
  - wiki
  - obsidian
status: stable
ask_examples:
  - Can the wiki use my existing Obsidian vault?
  - How does the iCloud-sandbox fallback work?
  - What does Adopt vs Migrate mean?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - external vault
  - existing obsidian vault
  - point at vault
  - wiki external
related:
  - features/wiki/overview
  - guides/build-your-wiki
  - guides/budget-and-cost-for-wiki
  - troubleshooting/wiki-write-failed
---

# Use an Existing Obsidian Vault

## Goal

Aitne can point the wiki subsystem at a vault you already maintain
in Obsidian, instead of creating its own at `$PA_DATA_DIR/wiki`.
This is "external mode", and the setup wizard walks you through
three decisions: **probe**, **classify**, then **Adopt vs Migrate
vs Split**.

## Step 1 — Open Settings → Wiki

Click **Setup → Settings → Wiki** in the dashboard sidebar (or open
`/wiki` and follow the **Enable Wiki** button — both land on the same
page). If you have no workspace yet, the page shows two CTAs:

- **Enable Internal Workspace** — uses the daemon-owned root.
- **Probe & Create External** — points at the path you choose with
  the folder picker.

### Picking the path

The path field uses your OS-native folder dialog so you do not have
to type the path by hand or worry about typos:

- **macOS** — Finder's "choose folder" sheet opens.
- **Windows** — File Explorer's folder picker opens.
- **Linux** — one of `zenity`, `kdialog`, or `yad` opens (whichever
  is installed on your system).

If you prefer to paste a path you already have on the clipboard, the
text field accepts that too — typing or pasting and clicking the
folder button are equivalent. Aitne refuses paths that overlap
`dataDir`, your primary vault, or the external Obsidian vault path so
two writers never claim the same files.

### Inline validation banner

Once you pick a directory, Aitne immediately calls `GET /api/fs/probe`
and renders a banner under the input. The banner has three severity
levels:

- **Error (red)** — save is blocked. The most common cause is a
  collision with another vault (primary, external Obsidian, dataDir,
  or another wiki workspace); the second is a path under a system
  prefix (`/etc`, `/var`, `/usr`, …) or matching a known secret-file
  pattern (`.ssh`, `.env`, `Library/Keychains`, …).
- **Warning (amber)** — save is allowed but something needs your
  attention. The most common case is "directory is not writable from
  the daemon" — Aitne will fall back to the Obsidian CLI at runtime,
  and you should leave Obsidian running.
- **Info (blue)** — nothing wrong. Used for "directory will be
  created on save" (the path does not exist yet) and for "Obsidian
  vault detected" / "existing LLM-Wiki layout detected" hints. When
  an existing wiki layout is detected, the wizard will surface the
  Adopt / Migrate decision in Step 3.

The **Probe & Create External** button is greyed out while the banner
is an error so you cannot fire a workspace-create that the daemon
already knows will fail.

## Step 2 — Probe Classifies the Vault

The wizard calls `POST /api/wiki/workspaces/probe` and one of three
classifications comes back:

- **empty** — no markdown files anywhere. Aitne creates the layered
  skeleton (`00_inbox/`, `10_raw/`, `20_wiki/`, `30_outputs/`,
  `90_meta/`) and seeds `90_meta/taxonomy.md` + the schema templates.
- **partial** — fewer than two layer directories. This usually means
  the directory holds unrelated notes. The wizard nudges you to
  inspect before continuing so Aitne does not silently take over a
  foreign vault.
- **wiki** — two or more layer directories. The wizard surfaces
  schema deltas and the top `type:` values it detected, then offers
  Adopt / Migrate / Split.

## Step 3 — Adopt / Migrate / Split

| Option | What it does |
|---|---|
| **Adopt** | Keeps your existing schema and subdirectory layout verbatim. Aitne's wiki agent gets a workspace-specific addendum so it follows your conventions. |
| **Migrate** | Flattens type-based subdirectories (`20_wiki/concepts/x.md → 20_wiki/x.md`) and renames legacy frontmatter keys (`topic → title`, `source_url → url`, …) to Aitne's Bases-era schema. Always writes a backup mirror under `90_meta/health/pre-migrate-<date>/` first. |
| **Split** | Refuses to touch the existing vault and creates a sibling workspace instead. Available once multi-workspace lands. |

When you pick **Migrate**, the dashboard renders the plan — files
that will be moved, frontmatter renames per file, slug collisions to
resolve — before any write hits disk. Apply only once the plan looks
right; the report lands at `90_meta/health/import-<date>.md`.

## Step 4 — First Compile

After the workspace is created (and migrated, if you chose that
path), you can:

- Run `!compile` for an incremental compile of any pre-existing raw
  notes.
- Run `!compile full` for a one-shot full rebuild — but check the
  cost estimate banner first. Above the per-workspace threshold
  (default $2.00) the command queues an approval in the dashboard
  rather than spending autonomously.

If your external vault is also a git repo, Aitne automatically
commits a `pre-compile snapshot` on a clean working tree before
`!compile full` so you can roll back if the result surprises you. A
dirty tree refuses the operation entirely — commit or stash first.

## iCloud-Sandboxed Vaults

When Aitne's direct filesystem writes return `EPERM` (typical for
iCloud and other sandboxed locations), the daemon falls back to the
official Obsidian CLI. Requirements:

- Obsidian 1.12 or later installed.
- **Settings → General → Command line interface** enabled inside
  Obsidian.
- The Obsidian app must be running (the CLI talks to the live
  process).

The resolved write strategy is persisted into the workspace row so
the probe only runs once. The dashboard write-strategy dropdown lets
you pin `fs` or `cli` explicitly when you trust your own answer.
