---
schema_version: 1
slug: guides/build-your-wiki
title: Build Your Wiki
id: build-your-wiki
aliases:
  - build wiki
  - wiki walkthrough
  - first wiki
  - ingest compile
category: guides
summary: |
  Enable the internal wiki, send your first URL, compile the raw
  notes, and ask a question against the vault.
section: build-your-wiki
tags:
  - guide
  - wiki
  - knowledge
status: stable
ask_examples:
  - How do I start using the wiki?
  - How do I add my first source to the wiki?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - wiki
  - build wiki
  - !ingest
  - !compile
  - !ask
  - workspace
  - first day wiki
related:
  - features/wiki/overview
  - features/wiki/commands
  - guides/use-an-existing-obsidian-vault
  - guides/budget-and-cost-for-wiki
---

# Build Your Wiki

## Goal

Stand up the internal wiki, capture a URL, compile it into a wiki
article, and run a question against the result.

## Prerequisites

- A paired messaging channel (Telegram, Slack, Discord, WhatsApp, or
  dashboard chat).
- The daemon is running and the dashboard is reachable.

## Where you'll work in the dashboard

The wiki has two pages, mirroring how the rest of the dashboard is
split: configuration lives under **Setup → Settings**, content
browsing lives under **My Life**.

- **My Life → Wiki** (`/wiki`) — your main entry point. Shows
  workspace stats, the compiled `_index.md`, and recent activity. When
  the wiki is not enabled yet, this page renders an **Enable Wiki**
  call-to-action.
- **Setup → Settings → Wiki** (`/settings/wiki`) — workspace creation,
  internal/external mode, per-command model selectors, budgets,
  archive / delete.

The **My Life → Wiki** sidebar entry is always visible, even before
you enable a workspace, so you do not need to remember the URL.

## Steps

1. Click **My Life → Wiki** in the sidebar (`/wiki`). The page shows
   a "Wiki not enabled" card with an **Enable Wiki** button —
   clicking it jumps you to `/settings/wiki`.
2. On the settings page, click **Enable Internal Workspace**. The
   daemon creates `$PA_DATA_DIR/wiki/` and seeds `90_meta/taxonomy.md`
   plus the schema templates. (To point at an existing Obsidian
   vault instead, follow
   [Use An Existing Obsidian Vault](use-an-existing-obsidian-vault.md).)
3. The sidebar's **My Life → Wiki** entry now lands on a workspace
   summary instead of the disabled CTA. Open it to confirm the root
   path, counts, and quick links to **Timeline & health** and
   **Configuration**.
4. From a paired DM, send `!ingest https://example.com/article`. You
   will get an acknowledgement reply naming the workspace and the
   number of URLs queued.
5. Wait for the per-URL completion DMs (parallel mode) or the single
   summary reply (serial mode).
6. Run `!compile` to compile raw captures into wiki articles. The
   compile session synthesises `20_wiki/<slug>.md` files and updates
   `20_wiki/_index.md`.
7. Ask a question: `!ask What did this source say about X?`. The
   answer is written to `30_outputs/<YYYY-MM-DD>-<slug>.md` with
   citations back to the source articles. Refresh **My Life → Wiki**
   to see the updated activity log.

Use `!wiki` any time to see counts and workspace status. `!wiki help`
returns the command list.

## What to Try Next

- **Send multiple URLs at once**: `!ingest https://a.com, https://b.com`
  fans out in parallel by default. Switch to serial mode on
  `/settings/wiki` when you care about ordering and rate
  predictability.
- **Point at an existing Obsidian vault** instead of the daemon-owned
  root — see [Use An Existing Obsidian Vault](use-an-existing-obsidian-vault.md).
- **Tune the budget** for `wiki.compile` and `wiki.ingest_url` from
  the per-command model selector on `/settings/wiki`. See
  [Wiki Budgets and Cost](budget-and-cost-for-wiki.md) for the
  approval gate.
