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
  Last-resort escape hatch — stop the daemon, delete the database, re-launch.
  Almost never needed; Aitne upgrades via forward-only schema migrations
  applied automatically at boot. Use this only when migrations fail or the
  DB is genuinely corrupt.
section: reinstall-cleanly
tags:
  - guide
  - operations
  - reinstall
  - migration
  - backup
status: stable
ask_examples:
  - How do I reinstall Aitne?
  - My DB seems corrupt — how do I start over?
  - What does a clean reinstall delete?
  - Do I need to wipe the DB to upgrade Aitne?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - reinstall
  - factory reset
  - wipe
  - fresh install
  - PA_DATA_DIR
  - aitne uninstall
  - schema migration
  - corrupt database
  - clean-context
related:
  - guides/backup-and-restore
  - guides/migrate-machines
  - guides/pause-the-agent
  - glossary
---

# Reinstall Cleanly

## You Almost Never Need This

Aitne upgrades through **forward-only schema migrations** applied at
daemon boot — your DB and context files survive every
`npm install -g @aitne-sh/aitne@latest` upgrade. If you're reading this
because you just upgraded, **don't run the steps below**; restart the
daemon and let the migration runner do its job.

This guide is the last-resort escape hatch for:

- The DB is genuinely corrupt and `aitne start` fails with a SQLite
  error you can't recover.
- You want to start over with a fresh setup wizard pass for an
  unrelated reason (handing the install to someone else, debugging a
  reproducible setup bug).

For everything else, prefer:

- **Moving to a new machine** → [Migrate Machines](migrate-machines.md).
- **Recovering from accidental edits** →
  [Backup and Restore](backup-and-restore.md).
- **Just pausing the agent** → [Pause the Agent](pause-the-agent.md).

## Pick the Right Reset

This guide wipes **only the SQLite database** (sessions, actions,
observations) and keeps your context Markdown. Three other resets exist
with different scopes — make sure you're running the one you mean:

| You want to… | Run | Wipes |
|---|---|---|
| Reset the DB, keep memory | this guide (`rm …/personal_agent.db*`) | SQLite only |
| Reset memory, keep the DB | `aitne restart --clean-context` | `context/` + `md_file_snapshots` (tarball backup first; type `CLEAN` to confirm) |
| Remove Aitne entirely | `aitne uninstall --wipe-data` | the whole `~/.personal-agent` data dir |
| Keep all data, just remove the binary | `aitne uninstall --keep-data` | nothing under the data dir |

## Before You Wipe

1. **Read the daemon log** (`aitne logs -n 200`) and copy the failing
   line. If it's a migration error, the fix is usually upstream — file
   an issue rather than wiping the DB and losing your history.
2. **Back up context.**
   ```bash
   cp -R ~/.personal-agent/context backup/
   ```
   Context Markdown is what makes the agent know who you are; the DB is
   recoverable, context is not.
3. **Back up the DB** if there's any chance you'll want to recover it
   later:
   ```bash
   cp ~/.personal-agent/data/personal_agent.db backup/
   ```

## The Reset

1. Stop the daemon.
   ```bash
   aitne stop
   ```
2. Delete the SQLite file and its WAL/SHM companions.
   ```bash
   rm ~/.personal-agent/data/personal_agent.db*
   ```
   (The `*` glob clears `-shm` / `-wal` left behind by WAL mode. The DB
   lives inside `data/`, not at the top of the data dir.)
3. Start the daemon.
   ```bash
   aitne start
   ```
4. Walk the setup wizard again. Your context files are still there;
   the wizard re-pairs messaging, re-registers backends, and re-seeds
   the schema from scratch.

## Verify

- A new `data/personal_agent.db` is created on launch.
- `aitne status` shows the daemon and dashboard both running.
- The setup wizard prompts you for credentials and pairing again.

## Related

- [Backup and Restore](backup-and-restore.md)
- [Migrate Machines](migrate-machines.md)
- [Schema Migration](../glossary.md#schema-migration) — the boring
  alternative to this guide that runs automatically on every boot.
