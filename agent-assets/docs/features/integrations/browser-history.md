---
schema_version: 1
slug: features/integrations/browser-history
title: Browser History
id: browser-history
aliases:
  - browser history
  - browsing history
  - research clusters
  - reload memory
  - B-3
category: features
summary: |
  Local-only poller that reads the browser's own SQLite databases
  (Chrome / Safari / Firefox / Arc), records visits as observations,
  derives research clusters from sustained reading patterns, and
  surfaces what you keep refreshing. Nothing leaves the daemon.
section: integrations
tags:
  - integrations
  - observations
  - browser-history
status: stable
ask_examples:
  - How does Aitne use my browser history?
  - What is a research cluster?
  - What does `!checks` show?
  - Does my browsing data go anywhere?
  - How do I opt out of browser history?
locale: en-US
created: 2026-05-22
updated: 2026-05-22
keywords:
  - browser history
  - browser history poller
  - research cluster
  - reload signal
  - "!checks"
  - "!research"
  - shopping comparison
  - two-option offer
related:
  - features/messaging/bang-commands
  - features/integrations/notion
  - features/operations/managed-chromium
  - features/routines/weekly-review
  - features/routines/morning-routine
ui_anchors:
  - /settings/integrations/browser-history
config_keys:
  - browserHistoryConsentAccepted
  - browserHistoryBrowserOverrides
  - browserHistoryCategories
  - browserHistoryRetentionDays
  - browserHistorySearchQueryRetentionDays
  - browserHistoryLifecycle
  - browserHistoryResearchDomainAllowlist
  - browserHistoryResearchDomainDenylist
---

# Browser History

Aitne can read the SQLite history databases that Chrome, Safari,
Firefox, and Arc already maintain on disk, classify visits into
categories, and use the result to notice what you've been
researching, what you've been refreshing, and what comparison-shopping
windows you're in. Everything stays local — no URLs, titles, or
clicks leave the daemon.

## What It Does

- **Reads visits** from the browser's own history DB on a 30-min
  cadence (per browser, per profile) and inserts them into the
  daemon's `browser_visits` table.
- **Counts reloads** per `<domain>/<first-path>` into
  `browser_reload_signals`. Surfaced via [`!checks`](../messaging/bang-commands.md)
  for the agent-day and via the weekly review's "this week you
  checked" block.
- **Derives research clusters** when a topic crosses meaningful-visits
  / foreground-time / distinct-domain thresholds. Clusters live in
  `research_clusters` with a slug, display name, journal at
  `context/research/<slug>.md`, and a status (`active | dormant |
  muted | concluded`).
- **Offers engagement DMs** via the Two-Option Offer pattern when a
  cluster qualifies: pick "research dive" (parallel web research +
  summary) or "wiki summary" (Obsidian / Notion / local context).
  Accept paths run through `routine.research_dispatch` /
  `routine.research_wiki_summary`; decline silences offers for 14
  days; mute / unmute / rename / conclude via [`!research`](../messaging/bang-commands.md).
- **Detects shopping comparison windows** — 90-min sliding windows
  containing ≥3 distinct ASINs surface as comparison sessions the
  agent can summarise.
- **Powers the pre-morning digest** — yesterday's reading and reload
  patterns feed the morning routine's pre-pass digest.

## Privacy and Consent

- **Default off.** The integration does not start until the operator
  flips `browserHistoryConsentAccepted = true` at
  `/settings/browser-history`.
- **Local-only.** No request leaves the daemon. The browser's
  history file is opened read-only; the daemon never reaches into
  cookies, login sessions, or profile dirs other than the history DB.
- **Per-browser opt-in.** `browserHistoryBrowserOverrides` lets you
  enable / disable each detected browser independently and override
  the DB path for atypical installs.
- **Per-category gate.** `browserHistoryCategories` controls which
  visit categories (research / shopping / docs / media / …) get
  ingested. Categories you exclude are dropped at ingest time, not
  filtered later.
- **Retention.** `browserHistoryRetentionDays` (visits) and
  `browserHistorySearchQueryRetentionDays` (search queries) cap the
  on-disk window; older rows are deleted on the next ingest tick.
- **Domain controls.** `browserHistoryResearchDomainAllowlist` /
  `…Denylist` filter which domains can qualify a research cluster.

## How Clusters Qualify

A research cluster qualifies when the combination of meaningful visits,
foreground time, and distinct domains crosses the thresholds in
`DEFAULT_OFFER_THRESHOLDS` (tunable via `browserHistoryLifecycle`).
The poller calls `evaluateOfferTriggers` per active cluster on each
tick; once the rate-limit gate (`gateOfferRateLimit`) approves, a
Two-Option Offer DM is composed by `routine.research_offer_dm`. The
seventh-pass policy clears all pending-offer rows for the slug on
either accept path so a later cycle cannot re-offer the same cluster.

## Owner Controls

| Surface | What it does |
|---|---|
| `!checks` | Today's top reload patterns (pure DB read, safe while paused). |
| `!research` | List active + dormant clusters. |
| `!research <slug>` | Show one cluster's detail. |
| `!research accept <slug>` | Enqueue `routine.research_dispatch`. |
| `!research wiki <slug>` | Enqueue `routine.research_wiki_summary`. |
| `!research decline <slug>` | Silence offers for 14 days. |
| `!research mute <slug>` / `unmute` | Toggle offers off (until unmute) / restore. |
| `!research rename <slug> <new name>` | Change display name. |
| `!research conclude <slug>` | Mark concluded; preserve the journal. |
| Natural-language reply to an offer DM | The `browser-history-respond` skill bridges into the same `/api/browser-history/offers/<slug>/{accept,decline}` call. |

## When It Runs

| Signal | Cadence | Source |
|---|---|---|
| Visit ingest | Every 30 min per browser profile | `BrowserHistoryPoller` |
| Cluster engagement evaluation | Same tick as visit ingest | `pipeline/offer-triggers.ts` |
| Shopping-comparison window scan | Same tick, 7-day lookback | `SHOPPING_COMPARISON_WINDOW_MS` constants |
| Nightly journal append | Agent-day boundary | `routine.research_cluster_update` (lite tier, one row per active cluster per day) |
| Weekly reload-memory block | Friday weekly review | `routine.weekly_review` reads `/api/browser-history/reloads/weekly` |
| Pre-morning digest | Morning routine pre-pass | Yesterday's reading + reloads feed the digest block |

## When Something Goes Wrong

- **`/settings/browser-history` shows no browsers.** Run `aitne
  doctor` — the platform detector might be failing to resolve the
  user's profile dir. The daemon log line will name the candidate
  paths it tried.
- **A cluster keeps re-offering.** Check the `lastResearchOfferAt` /
  `lastWikiOfferAt` columns; the rate-limit gate uses those for the
  14-day backoff. `!research decline <slug>` stamps both fields.
- **`!checks` is empty.** That's the common case for a quiet day —
  the reload signals are gated to the agent-day, not UTC.

## Related

- [Managed Chromium](../operations/managed-chromium.md) — separate
  experimental flow for *driving* a Chromium profile (B-4), not
  reading browser history.
- [Weekly Review](../policies/routines/weekly-review.md)
- [Morning Routine](../policies/routines/morning-routine.md)
- [Bang Commands](../messaging/bang-commands.md)
- [Glossary: Research Cluster](../../glossary.md#research-cluster)
