---
schema_version: 1
slug: guides/migrate-machines
title: Migrate Machines
id: migrate-machines
aliases:
  - migrate
  - move machines
  - transfer install
  - move install
category: guides
summary: |
  Move a Aitne install to a new machine — install the daemon,
  copy the context directory, re-pair messaging apps.
section: migrate-machines
tags:
  - guide
  - operations
  - migration
status: stable
ask_examples:
  - Can I move Aitne to a new laptop?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - migrate
  - move install
  - PA_DATA_DIR
  - rsync
  - second machine
related:
  - guides/backup-and-restore
  - guides/reinstall-cleanly
---

# Migrate Machines

## Goal

Carry your Aitne identity to a new machine without losing
context-file history.

## Steps

1. On the old machine: `aitne stop`.
2. Copy `~/.personal-agent/context/` to the new machine.
3. On the new machine: install per [Install and Run](install-and-run.md).
4. Optionally copy `data/personal_agent.db` (skip if upgrading daemon versions).
5. Re-pair messaging apps and re-authorize integrations.

## Verification

- Context files match.
- Routines fire on the new machine's schedule.

## If It Fails

- OS-keychain credentials don't move automatically — re-authorize
  each backend on the new machine.

## Related

- [Backup and Restore](backup-and-restore.md)
