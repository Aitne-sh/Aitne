---
schema_version: 1
slug: pages/analytics
title: "Analytics Page"
id: page-analytics
aliases:
  - analytics page
  - cost page
  - metrics page
category: pages
summary: |
  The Analytics page shows usage and spend trends — Cost aggregates
  per-run USD by backend and process across days, weeks, and months;
  Metrics shows operational health like activity volume and error rates.
  All from the local database, nothing sent externally.
tags:
  - cost
status: stable
ask_examples:
  - What can I do on the Analytics page?
  - Where do I see how much the agent is spending?
  - How do I check the agent's error rate?
  - Is my usage data sent anywhere?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - analytics
  - cost
  - spend
  - metrics
  - error rate
related:
  - concepts/costs-and-quotas
  - features/operations/cost-tracking
  - features/operations/backend-routing
  - pages/activity
ui_anchors:
  - /analytics
---

# Analytics Page

The `/analytics` page takes the raw event log and turns it into usage and
spend trends, laid out across two tabs.

## What you can do here

- **Cost tab** — per-run USD spend (token counts × backend pricing),
  totaled by day, week, and month and split out by backend and process.
  This is where you answer "what is this costing me, and where."
- **Metrics tab** — how the agent is running: activity volume, a breakdown
  of what ran, error rates, and how many notifications went out.

All figures come from the daemon's local SQLite database — nothing is sent
to any external service.

## Where to go deeper

- [Costs & quotas](../concepts/costs-and-quotas.md) — how spend and
  budgets work.
- [Cost tracking](../features/operations/cost-tracking.md) — how per-run
  cost is computed and attributed.
- [Backend routing](../features/operations/backend-routing.md) — why one
  backend costs more than another.

## Related

- [Agent Log page](activity.md) — the per-event detail behind these totals.
- [Settings → Models](settings.md) — change which model handles which tier.
