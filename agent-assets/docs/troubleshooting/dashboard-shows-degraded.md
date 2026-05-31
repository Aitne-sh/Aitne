---
schema_version: 1
slug: troubleshooting/dashboard-shows-degraded
title: Dashboard Shows Degraded
id: dashboard-shows-degraded
aliases:
  - dashboard degraded
  - degraded banner
  - daemon degraded
  - primary vault unreachable
  - writes are blocked
category: troubleshooting
summary: |
  A red "Daemon degraded" banner appears above every page when the daemon
  enters degraded mode. This almost always means your Obsidian-style primary
  vault is unreachable (path moved, drive unplugged, or not yet seeded), or a
  context migration is in progress. While degraded, every context write is
  refused with HTTP 503.
section: troubleshooting
status: stable
tags:
  - troubleshooting
  - operations
  - health
  - memory
ask_examples:
  - Why is the dashboard showing a degraded banner?
  - What does "primary vault unreachable" mean?
  - Why are context writes being refused with 503?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - degraded
  - degraded banner
  - primary vault unreachable
  - management mode
  - /api/health
  - "503"
config_keys:
  - vaultMode
  - primaryVaultPath
api_endpoints:
  - GET /api/health
context_files:
  - policies/management.md
ui_anchors:
  - /settings
  - /health
related:
  - troubleshooting/auth-failed
  - guides/use-an-existing-obsidian-vault
  - concepts/memory-model
---

# Dashboard Shows Degraded

## What You See

- A red banner pinned above every page. Its headline is either
  **"Primary vault unreachable"** or **"Daemon degraded: `<reason>`"**, often
  followed by the offending path.
- An **Open Management Mode** button on the right of the banner (links to
  Settings → Management Mode).
- Any routine or skill that writes a context file fails: the context API
  returns **HTTP 503** for every `POST`/`PUT`/`PATCH`/`DELETE` while degraded.

## What "Degraded" Actually Means

Degraded mode is set by the daemon's vault-health probe, which re-runs every
30 seconds. It is **not** about backend auth, message delivery, or a stuck
write lock — it is specifically about the daemon being unable to safely write
your memory files.

You only see this banner if you switched memory to an **Obsidian-style vault**
(`vaultMode: "obsidian"`). The default `vaultMode: "plain"` stores memory under
`~/.personal-agent/context/` and does not enter this state.

The `reason` in the banner is one of:

| `reason`                       | Meaning |
|--------------------------------|---------|
| `primary_vault_unreachable`    | The configured vault path doesn't exist, isn't a directory, or isn't writable (e.g. an external drive was unplugged). |
| `primary_vault_not_configured` | Vault mode is Obsidian but no `primaryVaultPath` is set. |
| `primary_vault_missing_content`| The path is reachable but doesn't carry the expected vault markers (it was never seeded / restructured). |
| `migration_in_progress`        | A context-vault migration (`/api/setup/migrate-context`) is running. Writes are gated until it finishes; reads still work. This one clears itself. |

## Diagnostic Steps

1. **Read the banner.** The `reason` and `path` tell you most of the story.
2. `aitne logs` — look for `Vault health probe entered degraded mode`; the
   logged `reason` matches the banner.
3. If the reason is `migration_in_progress`, **wait** — the migration releases
   the write gate when it completes; do not restart mid-migration.
4. Otherwise the issue is your vault path. Confirm it exists and is writable:
   - `ls -ld "<path-from-banner>"` — the directory must exist.
   - `df -h "<path-from-banner>"` — confirm the volume is mounted with free
     space (a full or read-only filesystem reports as `not_writable`).
   - If it lives on an external drive, re-mount the drive.

## Fixing It

Open **Settings → Management Mode** (the banner's button, or `/settings`):

- **Path moved or drive unplugged** — restore the original path, or point
  `primaryVaultPath` at the vault's current location.
- **You don't need an external vault** — switch Management Mode back to
  **This app** (`vaultMode: "plain"`); memory returns to
  `~/.personal-agent/context/`.
- **`primary_vault_missing_content`** — the target needs to be seeded. Re-run
  the Obsidian vault setup so `policies/management.md` and the rest of the
  skeleton are written into it. See
  [Use an existing Obsidian vault](../guides/use-an-existing-obsidian-vault.md).

## Confirming the Fix

- The vault-health probe re-runs every 30 seconds, and the dashboard refetches
  `/api/health` every 10 seconds. Once the path is reachable again, the banner
  clears within roughly half a minute — no restart needed.
- To check from the CLI without the dashboard, query the daemon:
  `curl -s localhost:8321/api/health | grep -o '"status":"[^"]*"'` — it should
  report `"status":"ok"` (degraded reports `"status":"degraded"` with a
  populated `degraded` object).

## Related

- [Auth Failed](auth-failed.md) — unrelated; covers backend auth, not the vault.
- [Use an existing Obsidian vault](../guides/use-an-existing-obsidian-vault.md)
- [Memory model](../concepts/memory-model.md)
