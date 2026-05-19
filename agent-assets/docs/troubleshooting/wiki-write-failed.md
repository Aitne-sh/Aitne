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
  - troubleshooting
  - wiki
  - obsidian
status: stable
ask_examples:
  - Why can't the wiki write to my Obsidian vault?
  - Why does the wiki health card say cliAvailable false?
  - How do I retry the write-strategy probe?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - wiki write failed
  - wiki API failure
  - wiki write lock
  - external vault write
related:
  - features/wiki/overview
  - guides/use-an-existing-obsidian-vault
---

# Wiki Write Failed

## What You See

A wiki bang command (`!ingest`, `!compile`) reports a write failure in
the daemon log, or the dashboard `/api/wiki/:ws/health` endpoint
surfaces a non-`fs` strategy with `cliAvailable: false`.

## Quick Checklist

1. **Internal mode?** Internal workspaces always write via the local
   filesystem. If you see EPERM there, the underlying issue is
   `dataDir` permissions — fix those rather than thinking the wiki
   is the problem.
2. **External mode + `write_strategy=fs`?** The filesystem rejected
   the write. Common causes:
   - iCloud sandbox (most frequent on macOS).
   - Read-only volume / snapshot mount.
   - Filesystem ACL on the parent directory.
3. **External mode + `write_strategy=cli`?** The probe already fell
   back to the Obsidian CLI but the CLI is unavailable. See the CLI
   checklist below.

## The CLI Fallback Path

When direct fs writes fail with `EPERM` / `EACCES` / `EROFS` /
`EBUSY`, Aitne falls back to the official Obsidian CLI (1.12+).
Requirements:

- Obsidian installed (1.12 or later).
- **Settings → General → Command line interface** enabled inside
  Obsidian.
- The Obsidian app is running (the CLI is a thin client to the live
  process).
- The `obsidian` binary is on `PATH` (`~/.zprofile` is auto-updated
  when CLI is enabled).

If any of these is missing, the daemon surfaces a structured error:

| Error code | Meaning |
|---|---|
| `EWIKI_CLI_UNAVAILABLE` | Aitne's `ObsidianService` is not configured. Open `Settings → Integrations → Obsidian` and complete the pairing. |
| `EWIKI_CLI_NOT_RUNNING` | Obsidian is not running. Launch the app and retry. |

## Force a Re-Probe

If you've fixed the underlying issue (granted iCloud permission,
mounted the disk read-write) but the cached strategy is still `cli`,
flip the dropdown in **Settings → Wiki → Write strategy** back to
`auto`. The next write probes again and persists the fresh outcome.
