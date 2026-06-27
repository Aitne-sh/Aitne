---
schema_version: 1
slug: features/operations/cost-tracking
title: Cost Tracking
id: cost-tracking
aliases:
  - analytics
  - cost rollup
  - spend tracking
category: features
summary: |
  Aitne records the USD cost of every run into the local SQLite database
  and rolls it up on the Analytics page by backend, by event type, and
  over daily / weekly / monthly windows. The sidebar footer shows today's
  running total, and two optional caps (daily and monthly) guard
  autonomous spend.
section: operations
tags:
  - core
  - cost
  - operations
status: stable
ask_examples:
  - How much did the agent cost me today?
  - Which routines are the most expensive?
  - How do I cap autonomous spending?
  - What is the difference between the daily and monthly cost cap?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - cost tracking
  - analytics
  - spend
  - per-process cost
  - rollup
  - cost cap
  - guardrails
related:
  - concepts/costs-and-quotas
  - concepts/process-keys
  - features/operations/backend-routing
ui_anchors:
  - /analytics
  - /analytics?tab=metrics
  - /settings/models
config_keys:
  - autonomousDailyCostCapUsd
  - autonomousMonthlyCostCapUsd
api_endpoints:
  - GET /api/metrics
  - GET /api/health
---

# Cost Tracking

## In One Sentence

Aitne meters the USD cost of every run, stores it locally, and rolls it
up on the Analytics page so you can see where your spend goes — and cap it
if you want.

## How It Works

- Each agent run writes its estimated cost into the `cost_usd` column of
  the `agent_actions` table. The estimate is `token count × backend
  pricing` — Aitne's best guess, never a bill.
- All data is derived from the daemon's local SQLite database and is never
  sent anywhere external.
- The day boundary for "today" is the agent day (04:00 local by default),
  not midnight.

## Where to Look in the Dashboard

### Analytics page (the rollup)

Open **Analytics**. It has two tabs:

- **Cost** — per-run USD spend. A period selector switches between
  **Daily**, **Weekly**, and **Monthly** windows, with summary cards for
  **Today**, **Last 7 Days**, and **Last 30 Days**. Inside Cost:
  - **Today's Spend Drivers** — answers "what is costing money *right
    now*". **Most Expensive Runs Today** lists the day's costliest runs
    (top 15, most expensive first); click a row for the full per-run
    detail, including the actually-billed model and cache token breakdown.
    Next to it, **By Process Today** shows each process's share of today's
    total, and **Today at a Glance** tracks the day's efficiency: cache
    hit rate, autonomous spend share, failed-run spend (money paid for
    runs that produced no result), average cost per run, and total token
    volume. Everything here uses the agent-day boundary, so the numbers
    reconcile with the **Today** summary card.
  - **Overview** — a cost-trend chart over the selected period plus a
    **By Event Type** breakdown (which process keys cost the most).
  - **By Backend** — totals and a trend chart split by the backend that
    *actually executed* each run. This reflects fallbacks and Gemini
    auto-routing, not just your configured preferred backend.
- **Metrics** (`/analytics?tab=metrics`) — operational health: activity
  volume, execution breakdown, error rates, notification throughput.

Note on delegated work: only **cross-backend** delegated calls show up as
separate runs. Same-backend delegated/native calls roll up under the
parent session's totals.

### Sidebar footer (running daily total)

The left sidebar footer shows today's running spend (`health.todayCostUsd`
— `SUM(cost_usd)` over the current agent day). It updates as runs complete.

## Capping Autonomous Spend

**Settings → Models → Cost guardrails** holds two optional caps. Both are
disabled (blank) by default and apply only to **autonomous** work —
reactive work such as DMs and mentions always runs.

- **`autonomousDailyCostCapUsd`** (Autonomous Daily Cost Cap) — when
  today's autonomous spend reaches the cap, the dispatcher skips
  lower-priority routines first, using priority-based degradation:
  - `activity_scan` — skipped at 100% of the cap
  - `roadmap_refresh` — skipped at 120%
  - `evening_review` — skipped at 150%
  - `morning_routine` — last to be cut, only at 200%

  This leaves headroom for the morning briefing even when you're over
  budget.

- **`autonomousMonthlyCostCapUsd`** (Autonomous Monthly Cost Cap — alert
  only) — a notification threshold for rolling 30-day spend. It surfaces a
  warning at 80% and an error at 100% in the Notifications panel but does
  **not** stop any work. Pair it with the daily cap if you want a hard
  guardrail.

## When a Cost Number Looks Wrong

Aitne's count is its best estimate from per-call token math, not the
provider's invoice. If a number looks off, cross-check it against the
backend's own usage dashboard.

## Related

- [Costs and Quotas](../../concepts/costs-and-quotas.md)
- [Process Keys](../../concepts/process-keys.md)
- [Backend Routing](./backend-routing.md)
