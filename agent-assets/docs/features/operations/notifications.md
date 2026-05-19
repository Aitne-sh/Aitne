---
schema_version: 1
slug: features/operations/notifications
title: Notifications
id: notifications
aliases:
  - notify
  - notification
  - alerts
category: features
summary: |
  Notifications are the agent's outbound DMs to the operator. They
  fire from routines, observations, and approvals. Quiet hours and
  rate limits gate the flow.
section: operations
tags:
  - core
  - notifications
  - operations
status: stable
ask_examples:
  - When does the agent send me a notification?
  - How do I limit how often it notifies me?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - notification
  - notify
  - quiet hours
  - rate limit
  - notification batch
related:
  - features/operations/quiet-hours
  - features/operations/approvals
  - features/messaging/overview
config_keys:
  - maxNotificationsPerHour
  - maxNotificationsPerDay
  - batchIntervalMinutes
  - primaryPlatform
---

# Notifications

## In One Sentence

Outbound DMs the agent sends through the paired messaging app, gated
by quiet hours and rate limits.

## What It Does

- Routines and observations enqueue notifications.
- Quiet hours hold notifications until the window ends.
- Per-hour and per-day rate limits cap the volume.
- Batching folds multiple small alerts into a single message.

## Configuration

| Setting | Default |
|---|---|
| `maxNotificationsPerHour` | 3 |
| `maxNotificationsPerDay` | 12 |
| `batchIntervalMinutes` | 15 |
| `primaryPlatform` | first paired |

## When Something Goes Wrong

- A notification you expected: check the rate-limit counters and the
  quiet-hours window.

## Related

- [Quiet Hours](quiet-hours.md)
- [Approvals](approvals.md)
