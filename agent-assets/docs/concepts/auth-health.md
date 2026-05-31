---
schema_version: 1
slug: concepts/auth-health
title: Auth Health
id: auth-health
aliases:
  - auth probe
  - auth recovery
  - credentials
  - auth health monitor
  - subscription auth warning
category: concepts
summary: |
  The auth-health monitor probes each backend's credentials at startup
  and on a recurring interval, surfaces failures on the dashboard, and
  triggers recovery flows when the right signal is available.
section: auth-health
tags:
  - core
  - safety
  - backends
  - operations
  - health
status: stable
ask_examples:
  - Why is the dashboard showing a degraded backend?
  - How does the agent check that I'm still logged in to Claude?
  - What happens when my Codex token expires?
  - What is the SubscriptionAuthWarning banner?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - auth
  - authentication
  - credentials
  - probe
  - degraded
  - auth health monitor
  - auth recovery
  - api-key-probe
  - SubscriptionAuthWarning
related:
  - concepts/backends-and-tiers
  - concepts/costs-and-quotas
  - troubleshooting/auth-failed
ui_anchors:
  - /settings/models
  - /
config_keys:
  - authProbeDisabled
  - authPreflightFreshnessMs
api_endpoints:
  - POST /api/backends/:backendId/check-auth
  - POST /api/backends/:backendId/recovery/start
  - GET /api/backends/:backendId/recovery/status
  - POST /api/backends/:backendId/recovery/code
  - POST /api/backends/:backendId/recovery/cancel
---

# Auth Health

## TL;DR

The daemon probes each configured backend on boot and at a freshness
interval. A failed probe flips the dashboard's auth-health card from
green to amber/red and surfaces a recovery hint.

## Why This Concept Exists

Routines silently failing because of an expired token is the most
common operator pain. The auth-health monitor is the proactive surface
that surfaces "your credentials expired" before the next morning
routine fails.

## Definitions

- **Probe**: a no-op call against each backend's auth surface. With
  a registered API key the probe hits the provider's lightweight
  `models` endpoint (Anthropic, OpenAI, Google) and verifies the key
  is live. Without an API key, the probe checks whatever local CLI
  login Aitne fell back to (Claude credentials store, Codex token,
  Gemini ADC).
- **Preflight freshness**: how long the daemon trusts a cached probe
  result before the router consults the backend again. Controlled by
  `authPreflightFreshnessMs` (default 600000 = 10 min). A cached
  `expired`/`missing` status younger than this window makes the router
  skip the main backend and route straight to fallback. Set to `0` to
  disable the pre-flight check entirely.
- **Recovery**: backend-specific repair. The recommended path is always
  re-pasting a paid API key on `/settings/models`. If you run on CLI
  subscription auth instead, you can recover the login from the same
  page: `/settings/models` exposes a recovery dialog that drives the
  backend's own interactive login subprocess —
  `claude auth login --claudeai` (browser OAuth), `codex login
  --device-auth` (device code), or Gemini's direct OAuth flow. As a
  manual fallback you can always re-run the backend's CLI login in a
  terminal yourself.

## Concrete Examples

- Anthropic API key revoked → probe fails → card flips red →
  operator pastes a new key on `/settings/models`. Per-call billing
  resumes against the new key on the next run.
- Operator never registered an API key, ran on the subscription
  fallback, and the underlying `claude` CLI session expired → probe
  fails → card flips amber → recommended fix is to register an API
  key on `/settings/models`. To keep using subscription auth instead,
  open the recovery dialog on the same page and complete the browser
  OAuth login it launches.

Cloud-provider credentials (Bedrock / Vertex / Foundry / Azure
OpenAI / Gemini-Vertex) are not probed against a `models` endpoint —
those providers trust the SDK's runtime auth chain, so the auth-
health card stays neutral until the first execution either succeeds
or surfaces a runtime auth error.

## The "API key recommended" warning

Separate from probe failures, `/settings/models` (and the setup
wizard's AI Backends step) shows a standing **API-key-recommended**
warning whenever a backend has no registered key. Skipping the key
falls the daemon back to that backend's local CLI subscription login,
which most providers do not officially support for automated agents —
Anthropic in particular currently prohibits running the Claude Agent
SDK on a Claude Pro / Max subscription. The warning is advisory, not a
probe result: it stays visible while you are on the fallback so you can
register a paid key and leave the gray area.

## Related

- [Backends and Tiers](backends-and-tiers.md) — tiers, models, and
  fallback routing.
- [Costs and Quotas](costs-and-quotas.md) — how API-key billing and
  quota signals interact.
- [Troubleshooting: Auth Failed](../troubleshooting/auth-failed.md) —
  step-by-step recovery when a card goes red.
