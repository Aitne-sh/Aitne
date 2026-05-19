---
schema_version: 1
slug: troubleshooting/auth-failed
title: Auth Failed
id: auth-failed
aliases:
  - credentials expired
  - login required
category: troubleshooting
summary: |
  A backend's auth-health card flipped amber or red. Re-authenticate
  via the backend's CLI or paste a fresh API key.
section: auth-failed
tags:
  - troubleshooting
  - safety
  - backends
status: stable
ask_examples:
  - Why is the auth-health card amber?
  - How do I re-login to Claude?
locale: en-US
created: 2026-04-25
updated: 2026-05-04
keywords:
  - auth failed
  - auth error
  - subscription warning
  - API key invalid
related:
  - concepts/auth-health
  - concepts/costs-and-quotas
  - features/operations/backend-routing
---

# Auth Failed

## What You See

- A red or amber pill on `/connections` or the dashboard health card.
- Routines failing with `BackendDecisiveFailure`.

## Most Likely Causes

1. **Provider API key revoked or rotated** — the most common cause
   on a healthy install. Re-paste the key on `/settings/models`.
2. **Subscription-fallback login expired** when no API key was
   registered (the daemon was running on the CLI's local login —
   `claude`, `codex login`, `gemini auth` — and that session timed
   out). The recommended fix is to register an API key.
3. **Account-level scope change** at the provider (key disabled,
   project deleted, billing suspended). For cloud providers
   (Bedrock / Vertex / Foundry / Azure OpenAI / Gemini-Vertex),
   IAM-role / service-account changes show up the same way.

## Diagnostic Steps

1. Click the pill to see the recovery hint.
2. Check `/settings/models` — the backend card shows whether it is
   running on a registered API key (the supported path) or on the
   subscription fallback. The `SubscriptionAuthWarning` banner
   appears whenever any backend is on the fallback.
3. If on the API key, paste a fresh key on `/settings/models` — the
   daemon mirrors it into `process.env` and re-probes immediately.
4. If on the subscription fallback, the recommended fix is to
   register an API key on `/settings/models` (or one of the cloud-
   provider options exposed on the same picker — Bedrock / Vertex /
   Foundry / Azure OpenAI / Gemini-Vertex).
   If you cannot or do not want to, run the corresponding CLI login
   (`claude`, `codex login`, `gemini auth`) and the daemon picks up
   the new credentials on the next probe. Note that this fallback
   is not provider-supported for automated agent use — see
   [Costs and Quotas](../concepts/costs-and-quotas.md).

## Confirming the Fix

- The pill flips green within `authPreflightFreshnessMs`.

## Related

- [Auth Health](../concepts/auth-health.md)
