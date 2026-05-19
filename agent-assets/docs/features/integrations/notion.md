---
schema_version: 1
slug: features/integrations/notion
title: Notion
id: notion
aliases:
  - notion database
  - notion integration
category: features
summary: |
  Watch a Notion database (or a curated set of pages) for changes.
  Changes record observations consumed by the hourly check.
section: integrations
tags:
  - integrations
  - knowledge
  - observations
status: stable
ask_examples:
  - How do I connect Notion?
  - Will Notion notify me on every page change?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - notion
  - page
  - database
  - notion observer
  - notion poller
related:
  - features/integrations/obsidian
  - features/routines/hourly-check
ui_anchors:
  - /connections/knowledge
config_keys:
  - notionPollIntervalSeconds
---

# Notion

## In One Sentence

A Notion integration polls a configured database / page set and
records observations on change.

## What It Does

- Polls Notion via the official API at `notionPollIntervalSeconds`.
- Records an observation per detected change.
- Lets the agent read pages on demand.

## When It Runs / How It Is Triggered

Continuous polling in `direct` mode. In `delegated` / `native` / `disabled`
modes the poller does not run — see Integration Modes below.

## Integration Modes

Notion supports all four integration modes (`direct` / `delegated` /
`native` / `disabled`), selected from **Connections → Knowledge**.

- **`direct`** — the daemon polls Notion itself, records change
  observations, and the hourly check consumes them.
- **`delegated`** — a delegated-sync worker runs on opt-in cadences;
  observations are recorded the same way but on a different
  schedule (see [Delegated Mode](../../concepts/delegated-mode.md)).
- **`native`** — the main backend reaches Notion through its own MCP
  connector on demand; the daemon does no polling. Observations
  flow in only when the main backend POSTs them in-turn via
  `/api/observations`. Available with Claude (`mcp__notion__*`).
- **`disabled`** — silence; no observations, no daemon access.

Switching modes requires the integration flip-lock probe to pass
(connector reachable, capabilities reported). See `POST /api/integrations/notion/probe`.

## Where in the Dashboard

- **Connections → Knowledge** holds the integration token, target
  databases, and the mode picker.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `notionPollIntervalSeconds` | 300 | Polling interval (direct mode only). |

## When Something Goes Wrong

- Notion's API rate-limits aggressively at high poll frequency. Stay
  ≥ 300 seconds.
- "No observations" in `native` mode is expected — observations flow
  only when the main backend POSTs them during a session.

## Related

- [Obsidian](obsidian.md)
