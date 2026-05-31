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
section: troubleshooting
tags:
  - troubleshooting
  - safety
  - backends
  - health
status: stable
ask_examples:
  - Why is the auth-health card amber?
  - How do I re-login to Claude?
  - The auth-health pill went red, what now?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - auth failed
  - auth error
  - subscription warning
  - API key invalid
  - BackendDecisiveFailure
  - re-authenticate
related:
  - concepts/auth-health
  - concepts/costs-and-quotas
  - features/operations/backend-routing
ui_anchors:
  - /settings/models
  - /connections
config_keys:
  - authPreflightFreshnessMs
  - authProbeDisabled
api_endpoints:
  - POST /api/backends/:backendId/check-auth
  - POST /api/backends/:backendId/recovery/start
  - POST /api/backends/:backendId/recovery/code
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
   project deleted, billing suspended). For cloud-provider auth
   (Bedrock / Vertex / Foundry for Claude, Vertex AI for Gemini),
   IAM-role / service-account changes show up the same way.

## Diagnostic Steps

1. Click the pill to see the recovery hint.
2. Open `/settings/models`. The backend card shows whether it is
   running on a registered API key (the supported path) or on the
   subscription fallback. The **API-key panel always carries the
   subscription-auth warning** — registering a paid key is the
   recommended path because several providers (Anthropic in
   particular) do not support running automated agents on a
   subscription plan.

## Fixing It

**If the backend is on a registered API key:** paste a fresh key on
`/settings/models`. The daemon mirrors it into `process.env` and
re-probes immediately — no restart needed.

**If the backend is on the subscription fallback:** the recommended
fix is to register an API key on `/settings/models`. The same picker
also exposes cloud-provider auth — Bedrock / Vertex / Foundry for
Claude, Vertex AI for Gemini. (Codex Azure OpenAI is not offered here;
it needs a `~/.codex/config.toml` the env-mirroring path cannot write,
so Codex stays direct-key only.)

If you cannot or do not want to register a key, re-run the
corresponding CLI login (`claude`, `codex login`, `gemini auth`) and
the daemon picks up the new credentials on the next probe. Some
backends also expose an in-dashboard device-code recovery flow
(`recovery/start` → `recovery/code`) reachable from the pill's
recovery hint. Note that subscription auth is not provider-supported
for automated agent use — see
[Costs and Quotas](../concepts/costs-and-quotas.md).

## Confirming the Fix

The pill flips green within `authPreflightFreshnessMs` of the next
probe (default 10 minutes).

## Related

- [Auth Health](../concepts/auth-health.md)
