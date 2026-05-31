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
  - notion
  - knowledge
  - observations
status: stable
ask_examples:
  - How do I connect Notion?
  - Will Notion notify me on every page change?
  - What does Notion native mode do?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - notion
  - page
  - database
  - notion observer
  - notion poller
  - integration modes
related:
  - features/integrations/obsidian
  - features/routines/hourly-check
  - concepts/delegated-mode
  - concepts/observations
ui_anchors:
  - /connections/knowledge
config_keys:
  - notionPollIntervalSeconds
api_endpoints:
  - POST /api/integrations/:key/probe
  - POST /api/observations
---

# Notion

Aitne polls a configured Notion database or page set, records an
observation on change, and the hourly check decides whether anything
warrants surfacing. The agent can also read pages on demand through
the `notion` skill.

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
  `POST /api/observations`. Supported when the main backend is
  Claude, Codex, or Gemini (each ships a Notion connector — e.g.
  Claude's is `mcp__claude_ai_Notion__*`). OpenCode hosts no native
  connectors, so selecting it as the main backend cascades Notion to
  `disabled`.
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
