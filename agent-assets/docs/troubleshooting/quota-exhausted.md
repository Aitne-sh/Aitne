---
schema_version: 1
slug: troubleshooting/quota-exhausted
title: Quota Exhausted
id: quota-exhausted
aliases:
  - api quota exceeded
  - rate limit
  - opus window
category: troubleshooting
summary: |
  A backend reported a quota error and the router fell over to the
  fallback. Wait for the provider window to refresh, raise your API
  spending limit, or pin a different model.
section: quota-exhausted
tags:
  - troubleshooting
  - cost
  - backends
  - quotas
  - routing
status: stable
ask_examples:
  - Why did Aitne fall over to the fallback backend?
  - Why is my Anthropic API call returning a quota error?
  - Why did an autonomous run get skipped for the cost cap?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - quota
  - BackendQuotaError
  - rate limit
  - fallback fired
  - 5h window
  - cost cap
ui_anchors:
  - /analytics
  - /settings/models
config_keys:
  - autonomousDailyCostCapUsd
  - autonomousMonthlyCostCapUsd
related:
  - concepts/costs-and-quotas
  - concepts/auth-health
  - guides/switch-default-backend
---

# Quota Exhausted

## What You See

- A `BackendQuotaError` row in Activity.
- Fallback ran the next routine instead of main.
- Or: an autonomous run was skipped with reason
  `autonomous_cost_cap_exceeded` — this is a *separate* safety net
  (`autonomousDailyCostCapUsd`, default off) that skips only autonomous
  work, never reactive DMs. (`autonomousMonthlyCostCapUsd`, also default
  off, is notifications-only — it never skips a run, just alerts.)
  It is not a provider quota error; raise the cap on `/settings/models`
  or wait for the next agent day.

## Most Likely Causes

1. **Provider rate limit** on your API key (Anthropic / OpenAI /
   Google) — the supported path. Check the provider console for the
   per-minute / per-day caps tied to your billing.
2. **Gemini per-agent-day request ceiling** reached. Aitne caps
   Gemini at 450 model requests per agent day (a conservative fraction
   of Google's free-tier daily limit on `GEMINI_API_KEY` /
   `GOOGLE_API_KEY` without billing). This ceiling is Gemini-only and
   model-agnostic — it is not tied to any one model id. The error reads
   "Gemini daily-request ceiling reached" and resets at the next
   agent-day boundary (04:00 local).
3. **Cloud-provider quota** — Bedrock / Vertex / Foundry / Azure
   OpenAI / Gemini-Vertex enforce their own per-region / per-model
   quotas. The error surfaces the same way as a direct-API quota.
4. **Subscription fallback exhausted** — no API key registered, so
   the backend is running on the CLI's local subscription login.
   The underlying provider's subscription limits then apply (e.g.
   Claude's rolling 5-hour Opus window on a Max plan login). The
   recommended fix is to register an API key on `/settings/models`;
   the fallback is not provider-supported for automated agent use.
   See [Costs and Quotas](../concepts/costs-and-quotas.md).

## Diagnostic Steps

1. Open `/analytics` and look at the by-backend rollup.
2. Check `/settings/models` to confirm whether the affected backend
   is on a registered API key (the `SubscriptionAuthWarning` banner
   is *absent*) or on the subscription fallback (banner *present*).
3. If on an API key, open the provider console and verify your
   account's spending / rate-limit settings. For cloud providers,
   open the matching console (AWS / GCP / Azure) and check the
   per-region / per-model quota.
4. If on the subscription fallback, the `BackendQuotaError` message in
   Activity carries the "next reset" timestamp for the rolling window
   (when the provider reports one). Consider registering an API key — see
   [Costs and Quotas](../concepts/costs-and-quotas.md).

## Confirming the Fix

- After a **provider window / Gemini ceiling** resets, the next run
  succeeds on the main backend (no `BackendQuotaError` row, no
  fallback).
- After raising or clearing the **autonomous cost cap**, autonomous
  runs stop logging `autonomous_cost_cap_exceeded` skips.

## Related

- [Costs and Quotas](../concepts/costs-and-quotas.md)
