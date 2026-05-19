---
schema_version: 1
slug: guides/backup-and-restore
title: Backup and Restore
id: backup-and-restore
aliases:
  - backup
  - restore
  - tarball backup
  - context backup
category: guides
summary: |
  Aitne's data lives in two places — the SQLite database and
  the context Markdown files. Back both up and restoration is a tar
  extract.
section: backup-and-restore
tags:
  - guide
  - operations
  - backup
status: stable
ask_examples:
  - How do I back up Aitne?
  - Can I restore on a new machine?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - backup
  - restore
  - tarball
  - rsync
  - git
  - PA_DATA_DIR
  - snapshot
related:
  - guides/reinstall-cleanly
  - guides/migrate-machines
---

# Backup and Restore

## Goal

Capture all Aitne state in a tar that you can restore later.

## Steps

1. `aitne stop`.
2. `tar -czf personal-agent-backup-$(date +%F).tgz ~/.personal-agent/`.
3. To restore: extract the tar to your home directory, then `aitne start`.

## Verification

- Activity feed shows historical rows after restore.
- Context files match the originals.

## If It Fails

- A schema-version mismatch: Aitne's policy is "clean
  reinstall, no data migration" — if the restored DB is from an
  older daemon version, drop the DB and re-seed from the context
  files.

## Related

- [Reinstall Cleanly](reinstall-cleanly.md)
- [Migrate Machines](migrate-machines.md)
