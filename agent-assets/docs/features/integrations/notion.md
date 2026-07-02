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
  Watch one or more configured Notion databases for changes.
  Changes record observations consumed by the activity scan.
section: integrations
tags:
  - integrations
  - knowledge
  - observations
status: stable
ask_examples:
  - How do I connect Notion?
  - Will Notion notify me on every page change?
  - What does Notion native mode do?
  - Why are my Notion routine fetches skipped?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - notion
  - page
  - database
  - notion observer
  - notion poller
  - integration modes
related:
  - features/integrations/obsidian
  - features/routines/activity-scan
  - concepts/delegated-mode
  - concepts/observations
ui_anchors:
  - /connections/notes
config_keys:
  - notionPollIntervalSeconds
api_endpoints:
  - POST /api/integrations/:key/probe
  - POST /api/observations
---

# Notion

Aitne watches the Notion databases you configure. When a page changes,
it records an *observation* (a short note that something happened), and
the [activity scan](../routines/activity-scan.md) — the routine that
periodically reviews recent activity — decides whether anything is worth
surfacing to you. The agent can also read Notion pages on demand through
the `notion` skill.

## What It Does

- Checks Notion through the official API on the interval set by
  `notionPollIntervalSeconds`.
- Records one observation for each change it detects.
- Lets the agent read pages on demand.

## When It Runs / How It Is Triggered

The poller runs continuously, but only in `direct` mode. In the
`delegated`, `native`, and `disabled` modes it does not run — see
[Integration Modes](#integration-modes) below.

## Integration Modes

Notion supports all four integration modes (`direct` / `delegated` /
`native` / `disabled`), selected from **Connections → Notes**.

- **`direct`** — the daemon polls Notion itself, records change
  observations, and the activity scan consumes them.
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

Switching modes requires the integration flip-lock probe to pass — a
quick check that the connector is reachable and reports its
capabilities. See `POST /api/integrations/notion/probe`.

## Routine Fetch Targets

Autonomous routine fetches (the `routine.fetch_window` pre-pass that
feeds the morning routine and activity scan) are limited to an explicit
allowlist of pages you configure under **Connections → Notes →
Routine fetch targets**. This prevents the agent from searching the
whole workspace on every pass — workspace-wide scans were the dominant
cost driver before the allowlist existed.

- Each target is a Notion page URL, page ID, or page title. Prefer a
  URL or ID; titles are matched best-effort and can be ambiguous.
- **Until at least one target is listed, routine Notion fetches are
  skipped entirely** (recorded as a `plan_drop:no_fetch_targets` skip in
  the activity log). On-demand reads in DMs are unaffected.
- Routine passes fetch at most 10 targets per window; extra entries are
  skipped each pass.
- The allowlist applies in every mode (`direct` / `delegated` /
  `native`) and survives mode switches and main-backend changes.

## Where in the Dashboard

- **Connections → Notes** holds the integration token, target
  databases, the routine fetch target allowlist, and the mode picker.
  The same Notion settings body appears in the setup wizard's Notes step.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `notionPollIntervalSeconds` | 300 | Polling interval (direct mode only). |

## When Something Goes Wrong

- Notion's API rate-limits aggressively at high poll frequency. Stay
  ≥ 300 seconds.
- "No observations" in `native` mode is expected — observations flow
  only when the main backend POSTs them during a session.
- Routine fetches silently absent? Check that **Routine fetch targets**
  is non-empty — an empty allowlist skips Notion in every routine pass
  (the activity log shows `plan_drop:no_fetch_targets`).

## Related

- [Obsidian](obsidian.md)
