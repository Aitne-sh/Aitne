---
schema_version: 1
slug: features/operations/cost-tracking
title: Cost Tracking
id: cost-tracking
aliases:
  - analytics
  - cost rollup
category: features
summary: |
  The Analytics page rolls cost up by ProcessKey, by backend, and by
  agent day. The sidebar footer shows the running daily total.
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
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - cost tracking
  - analytics
  - spend
  - per-process cost
  - rollup
related:
  - concepts/costs-and-quotas
config_keys:
  - autonomousDailyCostCapUsd
---

# Cost Tracking

## In One Sentence

A rolling rollup of token-cost per session, indexed by ProcessKey,
backend, and agent day.

## What It Does

- Records per-execute cost into `agent_actions`.
- Aggregates into the Analytics page's charts.
- Surfaces the running daily total in the sidebar footer.

## Where in the Dashboard

- **Analytics** is the rollup.
- **Settings → Models → Cost Guardrails** holds
  `autonomousDailyCostCapUsd`.

## When Something Goes Wrong

- A cost number that looks wrong: cross-check against the backend's
  own dashboard. Aitne's count is its best estimate from
  per-call token math.

## Related

- [Costs and Quotas](../../concepts/costs-and-quotas.md)
