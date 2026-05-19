---
schema_version: 1
slug: guides/reinstall-cleanly
title: Reinstall Cleanly
id: reinstall-cleanly
aliases:
  - reinstall
  - clean reinstall
  - factory reset
  - wipe data
  - fresh install
category: guides
summary: |
  Aitne's policy is "clean reinstall, no data migration".
  Stop the daemon, delete the data directory, re-launch — the setup
  wizard re-seeds.
section: reinstall-cleanly
tags:
  - guide
  - operations
  - reinstall
status: stable
ask_examples:
  - How do I reinstall Aitne?
  - What does a clean reinstall delete?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - reinstall
  - factory reset
  - wipe
  - fresh install
  - PA_DATA_DIR
  - aitne uninstall
related:
  - guides/backup-and-restore
---

# Reinstall Cleanly

## Goal

Reset Aitne's state without losing your context files.

## Prerequisites

- A backup of `~/.personal-agent/context/` if you want it back.

## Steps

1. `aitne stop`.
2. `cp -R ~/.personal-agent/context backup/` (optional).
3. `rm ~/.personal-agent/data/personal_agent.db*` (the SQLite file
   lives inside `data/`, not at the top of the data dir; the `*`
   also clears the `-shm`/`-wal` companions left behind by WAL mode).
4. `aitne start`.
5. Walk the setup wizard again.

## Verification

- A new `data/personal_agent.db` is created on launch.
- Setup wizard prompts you for credentials and pairing again.

## Related

- [Backup and Restore](backup-and-restore.md)
