---
schema_version: 1
slug: pages/wiki
title: "Wiki Page"
id: page-wiki
aliases:
  - wiki page
  - wiki dashboard
category: pages
summary: |
  The Wiki page is the dashboard for the personal wiki builder — an opt-in
  workspace that turns URLs, pastes, and notes you DM into a linked
  Markdown wiki. It shows the index and recent activity, or an enable
  prompt when no workspace exists yet.
tags:
  - wiki
  - knowledge
status: stable
ask_examples:
  - What can I do on the Wiki page?
  - How do I enable the wiki?
  - Where do I see my wiki's articles?
  - How do I add a source to my wiki?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - wiki
  - workspace
  - ingest
  - compile
  - articles
related:
  - features/wiki/overview
  - features/wiki/dashboard
  - features/wiki/commands
  - guides/build-your-wiki
ui_anchors:
  - /wiki
---

# Wiki Page

The `/wiki` page is where you read your wiki — the view surface for the
wiki builder. You build the wiki itself over DM. The wiki is opt-in: until
you enable a workspace, the page shows a **Wiki not enabled** card with a
prompt to turn it on.

## What you can do here

- **Enable a workspace** the first time, from the enable card.
- **Browse the index** of synthesized articles once a workspace is active.
- **Watch recent activity** — the latest captures, compiles, and answers.
- **Build the wiki over DM.** The real work happens through bang commands
  (messages that start with `!`) you send the agent: `!ingest` to capture,
  `!compile` to synthesize, `!ask` for cited answers, and
  `!lint` / `!trace` / `!connect` to audit, trace history, and bridge
  domains.

## Where to go deeper

- [Wiki overview](../features/wiki/overview.md) — the workspace concept and
  the `00_inbox` / `10_raw` / `20_wiki` / `30_outputs` layers.
- [Wiki dashboard](../features/wiki/dashboard.md) — this page and the
  timeline in detail.
- [Wiki commands](../features/wiki/commands.md) — the full `!` reference.
- [Build your wiki](../guides/build-your-wiki.md) — first-day walkthrough.

## Related

- [Knowledge page](knowledge.md) — the agent's own memory (distinct from
  the wiki).
- [Settings → Wiki](settings.md) — workspace configuration.
