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
  (Chrome / Chromium / Edge / Brave / Comet / Atlas), records visits as
  observations, derives research clusters from sustained reading
  patterns, and surfaces what you keep refreshing. Nothing leaves the
  daemon.
section: integrations
tags:
  - integrations
  - observations
  - polling
  - autonomous
status: stable
ask_examples:
  - How does Aitne use my browser history?
  - What is a research cluster?
  - What does `!checks` show?
  - Does my browsing data go anywhere?
  - How do I opt out of browser history?
locale: en-US
created: 2026-05-22
updated: 2026-07-01
keywords:
  - browser history
  - browser history poller
  - research cluster
  - reload signal
  - "!checks"
  - "!research"
  - shopping comparison
  - two-option offer
  - local-only
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
process_keys:
  - routine.research_cluster_update
  - routine.research_offer_dm
  - routine.research_dispatch
  - routine.research_wiki_summary
api_endpoints:
  - GET /api/browser-history/status
  - GET /api/browser-history/research-clusters
  - POST /api/browser-history/offers/:slug/accept
  - POST /api/browser-history/offers/:slug/decline
  - GET /api/browser-history/reloads/weekly
---

# Browser History

Every browser keeps a local history file (a small SQLite database) of
the pages you visit. Aitne can read that file for Chrome, Chromium,
Edge, Brave, Comet, and Atlas, sort each visit into a category, and use
the result to notice what you've been researching, what pages you keep
refreshing, and when you're comparison-shopping. Everything stays on
your machine — no URLs, titles, or clicks leave the daemon.

## What It Does

- **Reads visits** from the browser's own history file every 30
  minutes (per browser, per profile) and inserts them into the
  daemon's `browser_visits` table.
- **Counts reloads** per `<domain>/<first-path>` into
  `browser_reload_signals` — that is, how often you reopen the same
  page. These show up via [`!checks`](../messaging/bang-commands.md)
  for the current agent-day (Aitne's version of "today", which rolls
  over in the early morning rather than at midnight) and in the weekly
  review's "this week you checked" block.
- **Derives research clusters** when a topic passes the thresholds for
  meaningful visits, foreground reading time, and distinct domains. A
  cluster is a group of related pages Aitne thinks you're actively
  researching. Clusters live in `browser_research_clusters` with a
  slug, display name, journal at `context/research/<slug>.md`, and a
  status (`active | dormant | muted | concluded`).
- **Offers a direct message** when a cluster qualifies, using the
  Two-Option Offer pattern: pick "research dive" (parallel web research
  plus a summary) or "wiki summary" (into Obsidian / Notion / local
  context). Accepting runs `routine.research_dispatch` or
  `routine.research_wiki_summary`; declining silences offers for 14
  days; mute / unmute / rename / conclude via [`!research`](../messaging/bang-commands.md).
- **Detects comparison-shopping sessions** — a 90-min sliding window
  holding ≥3 distinct ASINs (Amazon product IDs) surfaces as a session
  the agent can summarize for you.
- **Powers the pre-morning digest** — yesterday's reading and reload
  patterns feed the digest that the morning routine reads.

## Privacy and Consent

- **Default off.** The integration does not start until the operator
  flips `browserHistoryConsentAccepted = true` on the
  **Settings → Integrations → Browser History**
  (`/settings/integrations/browser-history`) page. The integration only
  supports `direct` (the daemon poller) or `disabled` — there is no
  delegated or native mode.
- **Local-only.** No request leaves the daemon. The history file is
  opened read-only, and the daemon never touches cookies, login
  sessions, or any profile file other than that history database.
- **Per-browser opt-in.** `browserHistoryBrowserOverrides` lets you
  force each detected browser on or off independently
  (`auto` / `forced-on` / `forced-off`).
- **Per-category gate.** `browserHistoryCategories` controls which
  visit categories (research / shopping / news / dev / entertainment / …) get
  ingested. Categories you exclude are dropped at ingest time, not
  filtered later.
- **Retention.** `browserHistoryRetentionDays` (visits) and
  `browserHistorySearchQueryRetentionDays` (search queries) cap the
  on-disk window; older rows are deleted on the next ingest tick.
- **Domain controls.** `browserHistoryResearchDomainAllowlist` /
  `…Denylist` filter which domains can qualify a research cluster.

## How Clusters Qualify

A cluster qualifies once its meaningful visits, foreground time, and
distinct-domain counts all cross the thresholds in
`DEFAULT_OFFER_THRESHOLDS`. Those thresholds are fixed defaults;
`browserHistoryLifecycle` tunes how often the poller checks, not the
thresholds themselves.

Qualifying does not guarantee a message. On each tick the poller runs
the offer triggers for every active cluster (`evaluateOfferTriggers`),
which hold the 14-day, per-slug window before the same cluster can be
offered again. The **offer rate-limit gate** (`gateOfferRateLimit`) must
then approve too — it enforces a daily offer cap, a minimum gap between
offers, quiet hours, and a 30-day backoff after a decline. Only then
does the `routine.research_offer_dm` process key compose the Two-Option
Offer DM.

Accepting either path clears every pending-offer row for that slug, so a
later tick cannot re-offer the same cluster.

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
| Pre-morning digest | Daily, one hour before the agent-day boundary | Yesterday's reading + reloads feed the digest block |

## When Something Goes Wrong

- **The settings page shows no browsers.** Open
  `/settings/integrations/browser-history` and run `aitne doctor` — the
  detector may be unable to locate your browser's profile folder. The
  daemon log line lists the candidate paths it tried.
- **A cluster keeps re-offering.** Check the `lastResearchOfferAt` /
  `lastWikiOfferAt` columns; the trigger evaluator uses them for the
  14-day re-fire window (and the rate-limit gate reads them for its
  30-day decline backoff). `!research decline <slug>` stamps both
  fields.
- **`!checks` is empty.** That's normal for a quiet day — the reload
  signals are counted per agent-day, not per UTC day.

## Related

- [Managed Chromium](../operations/managed-chromium.md) — separate
  experimental flow for *driving* a Chromium profile (B-4), not
  reading browser history.
- [Weekly Review](../routines/weekly-review.md)
- [Morning Routine](../routines/morning-routine.md)
- [Bang Commands](../messaging/bang-commands.md)
- [Glossary: Research Cluster](../../glossary.md#research-cluster)
