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
  Move an Aitne install to a new machine — install the daemon, copy
  the data directory, re-pair messaging apps. The DB carries cleanly
  because schema migrations auto-forward at boot.
section: migrate-machines
tags:
  - operations
  - migration
  - backup
status: stable
ask_examples:
  - Can I move Aitne to a new laptop?
  - Will my DB still work after upgrading on the new machine?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
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

Carry your Aitne identity to a new machine without losing
context-file history or activity logs.

## What Moves and What Doesn't

| Carries cleanly | Re-do on the new machine |
|---|---|
| `~/.personal-agent/context/` (Markdown memory) | OS-keychain secrets (Anthropic / OpenAI / Google API keys) |
| `~/.personal-agent/data/personal_agent.db` (sessions, actions, observations, FTS) | Messaging pairing tokens (Slack / Telegram / Discord / WhatsApp) |
| `~/.personal-agent/logs/` (optional — for reference) | Integration OAuth grants (Gmail / Google Calendar / Notion) |

The database carries cleanly even across daemon versions. Each time it
starts, Aitne runs forward-only migrations from
`packages/daemon/src/db/migrations.ts` — one-way updates that bring an
older database up to the current shape. As long as you're upgrading
(not downgrading), the same database works.

## Steps

1. **On the old machine:** stop the daemon (the background Aitne process).
   ```bash
   aitne stop
   ```
2. **Copy the data directory** to the new machine — the context files
   plus the database. The command below uses `rsync`, a standard
   file-copy tool.
   ```bash
   rsync -av ~/.personal-agent/ user@new-host:~/.personal-agent/
   ```
   (Or copy just `context/` and `data/` if you want to skip the logs.)
3. **On the new machine:** install per [Install and Run](install-and-run.md).
4. **Re-register secrets and re-pair messaging** through the dashboard:
   - Re-register each backend's API key, or re-run its CLI auth flow for
     the subscription path: `claude auth login`, `codex login`, or for
     Gemini run `gemini` and choose **Sign in with Google**.
   - Walk the setup wizard's messaging pairing steps for each app you
     had paired.
   - Re-authorize each integration's OAuth grant — the access you
     approved for Gmail, Calendar, and Notion (the common ones).
5. Start the daemon.
   ```bash
   aitne start
   ```

On first boot the migration runner brings the carried database up to
the new daemon's schema. Check the daemon log if you want to see
exactly which migrations applied:

```bash
aitne logs -n 200 | grep -i migration
```

## Verify

- `aitne status` reports today's action count and spend, the connected
  platforms, and uptime — confirming the daemon booted against the
  carried DB.
- The dashboard's activity feed contains your historical rows; `aitne
  audit --since 30d` lists the same past actions you had on the old
  machine.
- Routines fire on the new machine's local schedule (timezone follows
  the OS).

## If It Fails

- **OS-keychain credentials don't move automatically** — Step 4 is the
  fix.
- **The daemon won't start with a SQLite error.** Read
  `aitne logs -n 200` for the failing migration. If the DB is genuinely
  corrupt, the last resort is
  [Reinstall Cleanly](reinstall-cleanly.md) — but context files survive
  that, so you only lose action history.
- **You downgraded the daemon by accident.** Migrations are forward-
  only; reinstall the newer version (`npm i -g @aitne-sh/aitne`) and
  retry.

## Related

- [Backup and Restore](backup-and-restore.md) — the source for the data
  you carry.
- [Install and Run](install-and-run.md) — Step 3 in detail.
- [Schema Migration](../glossary.md#schema-migration)
