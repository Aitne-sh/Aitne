---
schema_version: 1
slug: troubleshooting/fallback-keeps-firing
title: Fallback Keeps Firing
id: fallback-keeps-firing
aliases:
  - fallback firing
  - backend fallback
  - main backend down
category: troubleshooting
summary: |
  The router transitioned main → fallback for several runs in a row.
  Almost always main backend is unhealthy or quota-exhausted.
section: fallback-keeps-firing
tags:
  - troubleshooting
  - backends
  - routing
status: stable
ask_examples:
  - Why does the fallback keep running?
  - How do I stop the fallover loop?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - fallback
  - BackendQuotaError
  - BackendDecisiveFailure
  - router fallover
related:
  - troubleshooting/auth-failed
  - troubleshooting/quota-exhausted
  - features/operations/backend-routing
---

# Fallback Keeps Firing

## What You See

- Multiple recent Activity rows with backend != main.
- Notifications mentioning "fallback".

## Most Likely Causes

1. Main backend's auth has expired.
2. Main backend's heavy-tier window is depleted.
3. A `BackendDecisiveFailure` is repeating — usually a config issue.

## Diagnostic Steps

1. Open `/connections` — auth-health card.
2. Open `/analytics` — main-backend cost / quota.
3. Look at the failure detail in Activity for the offending row.

## Confirming the Fix

- The next run uses the main backend.

## Related

- [Auth Failed](auth-failed.md)
- [Quota Exhausted](quota-exhausted.md)
- [Backend Routing](../features/operations/backend-routing.md)
