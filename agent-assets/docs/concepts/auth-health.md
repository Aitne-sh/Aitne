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
  The auth-health monitor probes each backend's credentials on every
  activity-scan tick (default: every 2 hours), surfaces failures on the dashboard, and triggers
  recovery flows when the right signal is available.
section: auth-health
tags:
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
updated: 2026-07-01
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
  - troubleshooting/dashboard-shows-degraded
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

The daemon probes each configured backend on every activity-scan cron tick (default: every 2 hours).
A failed probe flips the dashboard's auth-health card from green to
red and surfaces a recovery hint.

## Why This Concept Exists

A routine that quietly fails because a token expired is the most
common operator headache. The auth-health monitor catches that early:
it tells you "your credentials expired" before the next morning
routine trips over the same problem.

## Definitions

- **Probe**: a lightweight test call that checks each backend's login
  without doing any real work. With
  a registered API key the probe hits the provider's lightweight
  `models` endpoint (Anthropic, OpenAI, Google) and verifies the key
  is live. Without an API key, the probe checks whatever local CLI
  login Aitne fell back to (Claude credentials store, Codex token,
  Gemini OAuth credentials).
- **Preflight freshness**: how long the daemon trusts a cached probe
  result before the router consults the backend again. Controlled by
  `authPreflightFreshnessMs` (default 600000 = 10 min). A cached
  `expired`/`missing` status younger than this window makes the router
  skip the main backend and route straight to fallback. Set to `0` to
  disable the pre-flight check entirely.
- **Recovery**: backend-specific repair. The recommended path is always
  re-pasting a paid API key on `/settings/models`. If you run on CLI
  subscription auth instead, you can recover the login by DMing the
  agent: `/auth fix claude`, `/auth fix codex`, or `/auth fix gemini`
  drives the backend's own interactive login flow —
  `claude auth login --claudeai` (browser OAuth), `codex login
  --device-auth` (device code), or Gemini's direct OAuth flow (open
  the URL, then DM the authorization code back). `/auth status` shows
  the current state; `/auth fix all` recovers every expired backend.
  As a manual fallback you can always re-run the backend's CLI login
  in a terminal yourself.

## Concrete Examples

- Anthropic API key revoked → probe fails → card flips red →
  operator pastes a new key on `/settings/models`. Per-call billing
  resumes against the new key on the next run.
- Operator never registered an API key, ran on the subscription
  fallback, and the underlying `claude` CLI session expired → probe
  fails → card flips red → recommended fix is to register an API
  key on `/settings/models`. To keep using subscription auth instead,
  DM the agent `/auth fix claude` and complete the browser OAuth
  login it links you to.

Cloud-provider credentials (Bedrock / Vertex / Foundry / Azure
OpenAI / Gemini-Vertex) are not probed against a `models` endpoint —
real verification is left to the SDK's runtime auth chain, so a bad
cloud credential only surfaces as a runtime auth error at execution
time. For the env-var-driven providers the probe just checks the
required env vars are present and marks the card OK ("Configured").

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
- [Dashboard Shows Degraded](../troubleshooting/dashboard-shows-degraded.md) —
  what to do when the dashboard flags a backend as degraded.
