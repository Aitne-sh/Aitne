---
schema_version: 1
slug: troubleshooting/wiki-write-failed
title: Wiki Write Failed
id: wiki-write-failed
aliases:
  - wiki EPERM
  - obsidian cli not detected
  - wiki write strategy stuck on cli
category: troubleshooting
summary: |
  A wiki bang command failed to write, or the dashboard health card
  shows a non-`fs` strategy with `cliAvailable: false`. Triage the
  filesystem permission vs. the Obsidian CLI fallback path.
section: wiki-write-failed
tags:
  - wiki
  - integrations
status: stable
ask_examples:
  - Why can't the wiki write to my Obsidian vault?
  - Why does the wiki health card say cliAvailable false?
  - How do I retry the write-strategy probe?
locale: en-US
created: 2026-05-12
updated: 2026-07-01
keywords:
  - wiki write failed
  - wiki API failure
  - wiki write strategy
  - external vault write
  - obsidian cli fallback
api_endpoints:
  - /api/wiki/:workspace/health
ui_anchors:
  - /settings/wiki
  - /connections/notes
related:
  - features/wiki/overview
  - guides/use-an-existing-obsidian-vault
---

# Wiki Write Failed

## What You See

A wiki bang command (`!ingest` or `!compile`) reports a write failure in
the daemon log. Or the wiki health check — `GET /api/wiki/:workspace/health`,
shown behind the dashboard's write-strategy badge — reports a strategy other
than `fs`, with `cliAvailable: false`.

## Quick Checklist

1. **Internal mode?** Internal workspaces always write to the local
   filesystem. If you see EPERM there, the real problem is `dataDir`
   permissions — fix those, not the wiki.
2. **External mode + `write_strategy=fs`?** The filesystem rejected
   the write. Common causes:
   - iCloud sandbox (the most frequent one on macOS).
   - A read-only volume or snapshot mount.
   - A filesystem ACL (access-control list) on the parent directory.
3. **External mode + `write_strategy=cli`?** The write probe already
   fell back to the Obsidian CLI, but the CLI is unavailable. See the
   CLI checklist below.

## The CLI Fallback Path

When a direct filesystem write fails with `EPERM` / `EACCES` / `EROFS` /
`EBUSY`, Aitne falls back to the official Obsidian CLI (1.12 or later).
For that fallback to work, you need:

- Obsidian installed (1.12 or later).
- **Settings → General → Command line interface** enabled inside
  Obsidian.
- The Obsidian app is running (the CLI is a thin client to the live
  process).
- The `obsidian` binary is on `PATH` (`~/.zprofile` is auto-updated
  when CLI is enabled).

If any of these is missing, the daemon surfaces a structured error:

| Error code | Meaning | Fix |
|---|---|---|
| `EWIKI_CLI_UNAVAILABLE` | Aitne's `ObsidianService` is not configured (the `obsidian` binary is not resolvable on `PATH`). | Open **Connections → Notes** and connect Obsidian via the Obsidian card, then confirm Obsidian 1.12+ is installed with the CLI enabled. |
| `EWIKI_CLI_NOT_RUNNING` | The CLI is configured but the Obsidian app is not running, so it cannot reach the sandboxed vault. | Launch the Obsidian app and retry. |

## Force a Re-Probe

Once a strategy (`fs` or `cli`) is resolved, Aitne caches it on the
workspace row so later writes can skip the probe. If you've fixed the
underlying problem (granted iCloud permission, remounted the disk
read-write) but the cached strategy is still `cli`, force a fresh probe:

1. Open **Settings → Wiki** (`/settings/wiki`) and edit the external
   workspace.
2. Set the **Write strategy** field back to **Auto (probe on first
   write)**. (This field only appears for external workspaces; internal
   workspaces always write via the local filesystem.)
3. Save. The next write probes again — trying direct `fs` first and
   falling back to the CLI only on `EPERM` / `EACCES` / `EROFS` /
   `EBUSY` — and persists the fresh outcome.
