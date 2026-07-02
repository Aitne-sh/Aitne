---
schema_version: 1
slug: troubleshooting/fallback-keeps-firing
title: Fallback Keeps Firing
id: fallback-keeps-firing
aliases:
  - fallback firing
  - backend fallback
  - main backend down
  - fallover loop
category: troubleshooting
summary: |
  The router keeps switching from your main backend to its fallback,
  run after run. Almost always the main backend is unhealthy
  (expired auth) or quota-exhausted. This doc shows how to confirm the
  cause and get runs back onto the main backend.
section: fallback-keeps-firing
status: stable
tags:
  - backends
  - routing
  - health
  - cost
keywords:
  - fallback
  - BackendQuotaError
  - BackendDecisiveFailure
  - router fallover
  - auth expired
  - quota exhausted
ask_examples:
  - Why does the fallback backend keep running?
  - How do I stop the fallover loop?
  - Why isn't my main backend being used?
ui_anchors:
  - /settings/models
  - /analytics
  - /activity
process_keys:
  - message.dm
  - routine.morning_routine
api_endpoints:
  - GET /api/health
  - POST /api/backends/:backendId/check-auth
config_keys:
  - autonomousDailyCostCapUsd
related:
  - troubleshooting/auth-failed
  - troubleshooting/quota-exhausted
  - features/operations/backend-routing
  - concepts/auth-health
  - concepts/backends-and-tiers
locale: en-US
created: 2026-04-25
updated: 2026-07-01
---

# Fallback Keeps Firing

For every run, the router picks two backends: a `main` and a `fallback`. (A
backend is the service that does the actual work — Claude, Codex, or Gemini.)
When the main backend can't take the job, the router quietly switches to the
fallback so the run still finishes. One switch now and then is normal. A
switch on run after run means the main backend has a lasting problem.

## What you see

- Multiple recent Activity rows whose backend is *not* your main backend.
- Notifications that mention a "fallback".

## Most likely causes

1. **The main backend's auth has expired.** This is the most common cause.
   The CLI credentials (or API key) for the main backend are no longer
   valid, so every run raises a `BackendDecisiveFailure("auth")` and the
   router falls over.
2. **The main backend's usage window is used up.** Claude and Codex count
   usage against a rolling window (a limit that refills over time); Gemini
   also has a per-day free-tier cap. Once the limit is reached, the backend
   raises a `BackendQuotaError` and the router falls over until the window
   resets.
3. **A repeating `BackendDecisiveFailure` from a config problem** — for
   example, the main backend's CLI isn't installed, a pinned model id no
   longer resolves, or execution-mode settings reject the run.

`BackendQuotaError` and `BackendDecisiveFailure` are the two signals the
router watches, and one of them is firing on every attempt.

## Diagnose

1. **Check auth on `/settings/models`.** Each backend has a card showing
   its auth status. If the main backend's card flags expired or failed
   auth, that's your cause — re-verify or re-authenticate it there.
2. **Check quota and spend on `/analytics` (Cost tab).** Look at the main
   backend's recent spend. Spend that flattens against a ceiling, or a
   window that has run dry, points to cause 2. If you set
   `autonomousDailyCostCapUsd`, autonomous runs also stop once the daily
   cap is hit (reactive DMs are never blocked by it).
3. **Read the failure detail in `/activity`.** Open the row that fell over
   to see the exact error. You can do the same from the CLI:

   ```bash
   # recent runs on the main backend that didn't succeed
   aitne audit --backend claude --result failed --since 24h
   ```

   (`--backend` accepts `claude`, `codex`, or `gemini`.)

## Fix

- **Expired auth →** re-authenticate the main backend from its card on
  `/settings/models`, then run a test. See [Auth Failed](auth-failed.md).
- **Exhausted quota →** wait for the usage window to reset, raise the cap,
  or accept the fallback until it clears. See
  [Quota Exhausted](quota-exhausted.md).
- **Config issue →** fix the reported problem (install the CLI, repin a
  valid model, relax execution mode) on `/settings/models`.

## Confirm the fix

- The next run uses the main backend again — visible in `/activity` or via
  `aitne audit --backend <id> --since 1h`.

## Related

- [Auth Failed](auth-failed.md)
- [Quota Exhausted](quota-exhausted.md)
- [Backend Routing](../features/operations/backend-routing.md)
- [Auth Health](../concepts/auth-health.md)
- [Backends and Tiers](../concepts/backends-and-tiers.md)
