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
  Aitne's durable state lives in one directory — PA_DATA_DIR
  (~/.personal-agent), holding the SQLite database and the context
  Markdown vault. Back it up with a tar after stopping the daemon;
  restoring is a tar extract. Secrets live in the OS keychain, not
  this directory, so re-register them after a restore.
section: backup-and-restore
tags:
  - guides
  - operations
  - backup
status: stable
ask_examples:
  - How do I back up Aitne?
  - Can I restore on a new machine?
  - Why are my API keys gone after restoring a backup?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - backup
  - restore
  - tarball
  - PA_DATA_DIR
  - snapshot
  - keychain
  - secrets
  - SQLite
related:
  - guides/reinstall-cleanly
  - guides/migrate-machines
---

# Backup and Restore

## Goal

Capture all of Aitne's durable state in a single tar archive you can
restore later — on this machine or a fresh one.

## What's in the backup (and what isn't)

Everything Aitne persists lives under `PA_DATA_DIR` (default
`~/.personal-agent`), so backing up that one directory captures it all:

- `data/personal_agent.db` — sessions, actions, observations, FTS index
  (plus the `-wal` / `-shm` companion files while the daemon runs).
- `context/` — the Markdown memory vault (today, roadmap, journal,
  knowledge, identity, policies, …).
- Logs, PID files, and prompts.

**Not in the tar — re-register these after a restore:**

- **Secrets** (Anthropic / OpenAI / Google API keys, etc.) live in the
  OS keychain, *not* under `~/.personal-agent`, so a tar never includes
  them.
- **Messaging pairings** (Slack / Telegram / Discord / WhatsApp tokens)
  are likewise keychain-backed.

Both are re-added through the dashboard after restore.

## Steps

1. **Stop the daemon** so the SQLite write-ahead log is checkpointed and
   the snapshot is consistent:

   ```bash
   aitne stop
   ```

2. **Create the archive** (capturing the whole data directory in one
   shot):

   ```bash
   tar -czf personal-agent-backup-$(date +%F).tgz ~/.personal-agent/
   ```

3. **Restore** by extracting the tar to your home directory, then
   starting the daemon:

   ```bash
   tar -xzf personal-agent-backup-2026-05-28.tgz -C ~/
   aitne start
   ```

   Schema migrations run automatically on the first boot (see below), so
   an older DB is brought up to the current shape without extra steps.

4. **Re-register secrets and re-pair messaging** through the dashboard —
   they were never in the tar.

## Verification

- `aitne status` reports the daemon healthy.
- The Activity feed shows your historical rows after restore.
- Context files match the originals.

## If It Fails

- **Schema mismatch on restore.** Aitne ships forward-only schema
  migrations applied automatically at boot (see
  [Schema Migration](../glossary.md#schema-migration)), so a restored DB
  from an older daemon version usually just works — the migration runner
  brings it up to the current shape on the next start. Only fall back to
  dropping the DB (see [Reinstall Cleanly](reinstall-cleanly.md)) if the
  daemon refuses to start *after* you've checked the log
  (`aitne logs`) for a real migration error.
- **The agent can't reach its backends after restore.** That's the
  missing keychain secrets — re-add your API keys in the dashboard
  (Step 4). The DB and context restore fine without them.

## Moving to a different machine?

This guide backs up and restores in place. To copy state to another host
(including the keychain re-registration walkthrough), follow
[Migrate Machines](migrate-machines.md).

## Related

- [Reinstall Cleanly](reinstall-cleanly.md)
- [Migrate Machines](migrate-machines.md)
