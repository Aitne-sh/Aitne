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
status: stable
ask_examples:
  - Why did Aitne fall over to the fallback backend?
  - Why is my Anthropic API call returning a quota error?
locale: en-US
created: 2026-04-25
updated: 2026-05-04
keywords:
  - quota
  - BackendQuotaError
  - rate limit
  - fallback fired
  - 5h window
related:
  - concepts/costs-and-quotas
  - concepts/auth-health
  - guides/switch-default-backend
---

# Quota Exhausted

## What You See

- A `BackendQuotaError` row in Activity.
- Fallback ran the next routine instead of main.
- Analytics shows the budget close to or past the cap.

## Most Likely Causes

1. **Provider rate limit** on your API key (Anthropic / OpenAI /
   Google) — the supported path. Check the provider console for the
   per-minute / per-day caps tied to your billing.
2. **Gemini per-day cap** for `gemini-2.5-flash` reached on the free
   tier (`GEMINI_API_KEY` without billing).
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
4. If on the subscription fallback, the backend card shows the
   "next reset" timestamp for the rolling window. Consider
   registering an API key — see
   [Costs and Quotas](../concepts/costs-and-quotas.md).

## Confirming the Fix

- The next run after the window resets succeeds on the main backend.

## Related

- [Costs and Quotas](../concepts/costs-and-quotas.md)
