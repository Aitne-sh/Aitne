---
schema_version: 1
slug: features/operations/backend-routing
title: Backend Routing
id: backend-routing
aliases:
  - router
  - main fallback
  - failover
category: features
summary: |
  BackendRouter resolves each ProcessKey to a (main, fallback) backend
  pair and a tier. On BackendQuotaError or BackendDecisiveFailure, the
  main backend's session fails over to the fallback's.
section: operations
tags:
  - core
  - operations
  - backends
status: stable
ask_examples:
  - What happens when my Claude quota is exhausted?
  - Why did my routine run on Codex when I picked Claude?
  - How do fallbacks work?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - backend routing
  - BackendRouter
  - fallback
  - main fallback
  - BackendQuotaError
  - BackendDecisiveFailure
related:
  - concepts/backends-and-tiers
  - features/operations/cost-tracking
---

# Backend Routing

## In One Sentence

Each ProcessKey resolves to a `(main, fallback)` pair and a tier; on
quota or decisive failure, the dispatcher transitions to the fallback
mid-run.

## What It Does

- Reads the `process_backend_config` table to find the binding.
- Falls back to the default tier map when no override exists.
- Re-materializes the session workdir for the fallback backend's
  instruction file and skill set.

## Where in the Dashboard

- **Settings → Models** is the unified surface for picking main and
  fallback per ProcessKey.
- **Activity** rows show which backend actually served each turn after
  fallback resolution.

## When Something Goes Wrong

- A `fallback-failed` notification: both backends rejected the run.
  Most often a credentials issue on both sides.

## Related

- [Backends and Tiers](../../concepts/backends-and-tiers.md)
